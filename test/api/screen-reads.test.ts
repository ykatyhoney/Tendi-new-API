import type { RowDataPacket } from 'mysql2/promise'
import mysql from 'mysql2/promise'
import { afterAll, describe, expect, it } from 'vitest'
import { buildApp } from '../../src/app.js'
import { loadConfig } from '../../src/config/env.js'
import { joinAddress } from '../../src/modules/family/services/mirror/derive.js'
import { issueDevToken, revokeDevTokens } from '../../scripts/dev-token.js'
import { loadAdminConfig } from '../../scripts/mariadb-admin.js'

/*
 * The reads added for the Tendi-new screens: GET /staff/me, GET /children and /children/:childId, the summary
 * address, households' relationship on a contact search, and each member's mirror slot. Nothing here writes
 * family data; the only rows added are the dev tokens, revoked at the end.
 */

const TEST_DATABASE = 'tendi_family_test'

const adminConfig = loadAdminConfig()
const connection = await mysql.createConnection({
  host: adminConfig.host,
  port: adminConfig.port,
  user: adminConfig.user,
  password: adminConfig.password,
  database: TEST_DATABASE,
  charset: 'utf8mb4',
  dateStrings: true,
  timezone: 'Z',
})

async function firstActiveAdmin(type: string): Promise<number> {
  const [found] = await connection.query<RowDataPacket[]>(
    `SELECT id FROM admin WHERE status = 'active' AND type = ? ORDER BY id LIMIT 1`,
    [type],
  )
  const id = Number(found[0]?.['id'])
  if (!Number.isInteger(id) || id < 1) {
    throw new Error(`tendi_family_test has no active ${type}.`)
  }
  return id
}

async function count(sql: string, params: unknown[] = []): Promise<number> {
  const [found] = await connection.query<RowDataPacket[]>(sql, params)
  return Number(found[0]?.['n'] ?? 0)
}

const adminId = await firstActiveAdmin('admin')
const officeId = await firstActiveAdmin('office')
const adminToken = await issueDevToken(connection, adminId)
const officeToken = await issueDevToken(connection, officeId)
const config = await loadConfig()
const app = await buildApp({
  config: { ...config, db: { ...config.db, name: TEST_DATABASE } },
  logger: false,
})
const auth = { authorization: `Bearer ${adminToken}` }

async function get(url: string, headers: Record<string, string> = auth) {
  return app.inject({ method: 'GET', url, headers })
}

interface ChildItem {
  id: number
  fname: string
  lname: string
  className: string
  status: string
  enrollmentStatus: string
  dob: string | null
  familyId: number | null
  familyName: string | null
}

/** Every item of a children query, page by page. */
async function allChildren(query: string): Promise<ChildItem[]> {
  const items: ChildItem[] = []
  for (let page = 1; page <= 50; page += 1) {
    const response = await get(`/api/v1/children?${query}&page=${page}&pageSize=100`)
    expect(response.statusCode, response.body).toBe(200)
    const body = response.json()
    items.push(...body.items)
    if (page * 100 >= body.total) {
      return items
    }
  }
  throw new Error('more than 50 pages of children')
}

describe('reads for the screens', () => {
  afterAll(async () => {
    await revokeDevTokens(connection, adminId)
    await revokeDevTokens(connection, officeId)
    await connection.end()
    await app.close()
  })

  describe('GET /staff/me', () => {
    it("returns the token's staff member and whether they may change relationship types", async () => {
      const admin = await get('/api/v1/staff/me')
      expect(admin.statusCode).toBe(200)
      expect(admin.json()).toMatchObject({ adminId, type: 'admin', relationshipAdmin: true })
      expect(typeof admin.json().name).toBe('string')

      const office = await get('/api/v1/staff/me', { authorization: `Bearer ${officeToken}` })
      expect(office.statusCode).toBe(200)
      expect(office.json()).toMatchObject({ adminId: officeId, type: 'office', relationshipAdmin: false })
    })

    it('refuses a missing or unknown token', async () => {
      expect((await get('/api/v1/staff/me', {})).statusCode).toBe(401)
      expect((await get('/api/v1/staff/me', { authorization: 'Bearer not-a-token' })).statusCode).toBe(401)
    })
  })

  describe('GET /children', () => {
    it('lists active children by default and never trashed ones', async () => {
      const response = await get('/api/v1/children')
      expect(response.statusCode).toBe(200)
      const body = response.json()
      expect(body).toMatchObject({ page: 1, pageSize: 25 })
      expect(body.total).toBe(await count(`SELECT COUNT(*) AS n FROM children WHERE status = 'active'`))
      expect(body.items).toHaveLength(Math.min(25, body.total))
      expect(body.items.every((item: ChildItem) => item.status === 'active')).toBe(true)

      const inactive = (await get('/api/v1/children?status=inactive&pageSize=1')).json()
      expect(inactive.total).toBe(await count(`SELECT COUNT(*) AS n FROM children WHERE status = 'inactive'`))
      const everyone = (await get('/api/v1/children?status=all&pageSize=1')).json()
      expect(everyone.total).toBe(body.total + inactive.total)
      expect(everyone.total).toBe(await count(`SELECT COUNT(*) AS n FROM children WHERE status <> 'trash'`))
    })

    it('filters linked and not linked children', async () => {
      const linked = await allChildren('status=all&linked=yes')
      expect(linked.length).toBe(
        await count(`SELECT COUNT(*) AS n FROM children WHERE status <> 'trash' AND family_id IS NOT NULL`),
      )
      expect(linked.every((item) => item.familyId !== null && item.familyName !== null)).toBe(true)

      const unlinked = await allChildren('linked=no')
      expect(unlinked.length).toBe(
        await count(`SELECT COUNT(*) AS n FROM children WHERE status = 'active' AND family_id IS NULL`),
      )
      expect(unlinked.every((item) => item.familyId === null && item.familyName === null)).toBe(true)
    })

    it('returns the class name, enrollment status, birth date, and family as stored', async () => {
      const [stored] = await connection.query<RowDataPacket[]>(
        `SELECT c.id, c.fname, c.lname, COALESCE(NULLIF(cl.friendly_name, ''), cl.name, '') AS className,
                c.enrollment_status AS enrollmentStatus, c.dob, c.family_id AS familyId, f.name AS familyName
         FROM children AS c
         INNER JOIN classes AS cl ON cl.id = c.\`class\`
         LEFT JOIN families AS f ON f.id = c.family_id
         WHERE c.status = 'active' AND c.family_id IS NOT NULL
         ORDER BY c.id
         LIMIT 1`,
      )
      const row = stored[0]
      expect(row, 'an active linked child with a class on file').toBeDefined()
      const response = await get(`/api/v1/children/${String(row?.['id'])}`)
      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({
        id: Number(row?.['id']),
        fname: row?.['fname'],
        lname: row?.['lname'],
        className: row?.['className'],
        status: 'active',
        enrollmentStatus: row?.['enrollmentStatus'],
        dob: row?.['dob'],
        familyId: Number(row?.['familyId']),
        familyName: row?.['familyName'],
      })
    })

    it('finds a child by first name, last name, full name, or id', async () => {
      const [found] = await connection.query<RowDataPacket[]>(
        `SELECT id, fname, lname FROM children WHERE status = 'active' AND fname <> '' AND lname <> '' ORDER BY id LIMIT 1`,
      )
      const child = found[0]
      const id = Number(child?.['id'])
      for (const q of [String(child?.['fname']), String(child?.['lname']), `${String(child?.['fname'])} ${String(child?.['lname'])}`, String(id)]) {
        const hits = await allChildren(`q=${encodeURIComponent(q)}`)
        expect(hits.some((item) => item.id === id), q).toBe(true)
      }
      const byId = await allChildren(`q=${id}`)
      expect(byId.every((item) => item.id === id || `${item.fname} ${item.lname}`.includes(String(id)))).toBe(true)

      const none = (await get(`/api/v1/children?q=${encodeURIComponent('%_no child is called this_%')}`)).json()
      expect(none.total).toBe(0)
    })

    it('treats a trashed or unknown child as not found', async () => {
      const [trashed] = await connection.query<RowDataPacket[]>(`SELECT id FROM children WHERE status = 'trash' LIMIT 1`)
      const trashedId = trashed[0]?.['id']
      if (trashedId !== undefined) {
        expect((await get(`/api/v1/children/${String(trashedId)}`)).statusCode).toBe(404)
        const search = (await get(`/api/v1/children?q=${String(trashedId)}&status=all`)).json()
        expect(search.items.some((item: ChildItem) => item.id === Number(trashedId))).toBe(false)
      }
      const unknown = await get('/api/v1/children/2147483647')
      expect(unknown.statusCode).toBe(404)
      expect(unknown.json()).toMatchObject({ code: 'NOT_FOUND' })
    })

    it('rejects an unknown filter and an oversized page', async () => {
      for (const query of ['status=trash', 'linked=maybe', 'pageSize=101', 'page=0']) {
        const response = await get(`/api/v1/children?${query}`)
        expect(response.statusCode, query).toBe(400)
        expect(response.json()).toMatchObject({ code: 'VALIDATION' })
      }
    })
  })

  describe('GET /families', () => {
    it("shows the main contact's home address, primary first, as the mirror joins it", async () => {
      const [mains] = await connection.query<RowDataPacket[]>(
        `SELECT m.family_id AS familyId, m.family_contact_id AS contactId
         FROM family_members AS m
         INNER JOIN family_contacts AS c ON c.id = m.family_contact_id AND c.status = 'active'
         WHERE m.status = 'active' AND m.is_primary = 1
         ORDER BY m.family_id, m.sort_order, m.id`,
      )
      const mainContact = new Map<number, number>()
      for (const row of mains) {
        const familyId = Number(row['familyId'])
        if (!mainContact.has(familyId)) {
          mainContact.set(familyId, Number(row['contactId']))
        }
      }
      const [homes] = await connection.query<RowDataPacket[]>(
        `SELECT family_contact_id AS contactId, line1, line2, city, state, zip
         FROM family_contact_addresses
         WHERE type = 'home'
         ORDER BY family_contact_id, is_primary DESC, id`,
      )
      const homeOf = new Map<number, string>()
      for (const row of homes) {
        const contactId = Number(row['contactId'])
        if (!homeOf.has(contactId)) {
          homeOf.set(contactId, joinAddress({
            line1: String(row['line1'] ?? ''),
            line2: String(row['line2'] ?? ''),
            city: String(row['city'] ?? ''),
            state: String(row['state'] ?? ''),
            zip: String(row['zip'] ?? ''),
          }))
        }
      }

      let withAddress = 0
      let seen = 0
      for (let page = 1; page <= 20; page += 1) {
        const body = (await get(`/api/v1/families?page=${page}&pageSize=100`)).json()
        for (const family of body.items as { id: number; address: string }[]) {
          const contactId = mainContact.get(family.id)
          const expected = contactId === undefined ? '' : homeOf.get(contactId) ?? ''
          expect(family.address, `family ${family.id}`).toBe(expected)
          if (expected !== '') {
            withAddress += 1
          }
          seen += 1
        }
        if (page * 100 >= body.total) {
          break
        }
      }
      expect(seen).toBe(await count(`SELECT COUNT(*) AS n FROM families WHERE status = 'active'`))
      expect(withAddress).toBeGreaterThan(0)
    })

    it("marks each summary member's mirror slot as the family page does", async () => {
      const body = (await get('/api/v1/families?pageSize=30')).json()
      for (const summary of body.items as { id: number; members: { name: string; mirrorSlot: string | null }[] }[]) {
        const detail = (await get(`/api/v1/families/${summary.id}`)).json()
        const expected = (detail.members as { mirrorSlot: string | null }[]).map((member) => member.mirrorSlot)
        expect(summary.members.map((member) => member.mirrorSlot), `family ${summary.id}`).toEqual(expected)
      }
    })
  })

  describe('GET /families/:id', () => {
    it('marks the father and mother the mirror writes, which match the linked children today', async () => {
      const [linked] = await connection.query<RowDataPacket[]>(
        `SELECT c.family_id AS familyId, MIN(c.id) AS childId
         FROM children AS c
         INNER JOIN families AS f ON f.id = c.family_id AND f.status = 'active'
         WHERE c.status <> 'trash'
         GROUP BY c.family_id
         ORDER BY c.family_id`,
      )
      expect(linked.length).toBeGreaterThan(0)
      let fathers = 0
      let mothers = 0
      for (const row of linked) {
        const familyId = Number(row['familyId'])
        const [stored] = await connection.query<RowDataPacket[]>(
          `SELECT c.father_name AS fatherName, c.mother_name AS motherName,
                  cai.father_fname AS fatherFname, cai.mother_fname AS motherFname
           FROM children AS c
           LEFT JOIN children_additional_information AS cai ON cai.child_id = c.id
           WHERE c.id = ?`,
          [row['childId']],
        )
        const response = await get(`/api/v1/families/${familyId}`)
        expect(response.statusCode).toBe(200)
        const members = response.json().members as {
          mirrorSlot: 'father' | 'mother' | null
          contact: { legacyFullName: string; fname: string }
        }[]
        const father = members.filter((member) => member.mirrorSlot === 'father')
        const mother = members.filter((member) => member.mirrorSlot === 'mother')
        expect(father.length, `family ${familyId}`).toBeLessThanOrEqual(1)
        expect(mother.length, `family ${familyId}`).toBeLessThanOrEqual(1)
        expect(father[0]?.contact.legacyFullName ?? '', `family ${familyId} father_name`).toBe(stored[0]?.['fatherName'] ?? '')
        expect(mother[0]?.contact.legacyFullName ?? '', `family ${familyId} mother_name`).toBe(stored[0]?.['motherName'] ?? '')
        expect(father[0]?.contact.fname ?? '', `family ${familyId} father_fname`).toBe(stored[0]?.['fatherFname'] ?? '')
        expect(mother[0]?.contact.fname ?? '', `family ${familyId} mother_fname`).toBe(stored[0]?.['motherFname'] ?? '')
        fathers += father.length
        mothers += mother.length
      }
      expect(fathers).toBeGreaterThan(0)
      expect(mothers).toBeGreaterThan(0)
    })
  })

  describe('GET /contacts', () => {
    it("lists each household's relationship, as the contact page does", async () => {
      const body = (await get('/api/v1/contacts?pageSize=20')).json()
      const withHouseholds = (body.items as { id: number; households: unknown[] }[]).filter(
        (item) => item.households.length > 0,
      )
      expect(withHouseholds.length).toBeGreaterThan(0)
      for (const item of withHouseholds.slice(0, 5)) {
        const detail = (await get(`/api/v1/contacts/${item.id}`)).json()
        const expected = (detail.households as { familyId: number; familyName: string; familyStatus: string; relationship: string; relationshipLabel: string }[])
          .filter((household) => household.familyStatus === 'active')
          .map(({ familyId, familyName, relationship, relationshipLabel }) => ({ familyId, familyName, relationship, relationshipLabel }))
        expect(item.households).toEqual(expected)
      }
    })

    it('filters by relationship codes held in an active household', async () => {
      const mothers = await count(
        `SELECT COUNT(DISTINCT m.family_contact_id) AS n
         FROM family_members AS m
         INNER JOIN families AS f ON f.id = m.family_id AND f.status = 'active'
         INNER JOIN family_contacts AS c ON c.id = m.family_contact_id AND c.status = 'active'
         WHERE m.status = 'active' AND m.relationship = 'mother'`,
      )
      const page = (await get('/api/v1/contacts?relationship=mother&pageSize=100')).json()
      expect(page.total).toBe(mothers)
      for (const item of page.items as { households: { relationship: string }[] }[]) {
        expect(item.households.some((household) => household.relationship === 'mother')).toBe(true)
      }
      const both = (await get('/api/v1/contacts?relationship=mother,father&pageSize=1')).json()
      expect(both.total).toBeGreaterThanOrEqual(mothers)
      const unused = (await get('/api/v1/contacts?relationship=car_service&pageSize=1')).json()
      expect(unused.total).toBe(
        await count(
          `SELECT COUNT(DISTINCT m.family_contact_id) AS n FROM family_members AS m
           INNER JOIN families AS f ON f.id = m.family_id AND f.status = 'active'
           INNER JOIN family_contacts AS c ON c.id = m.family_contact_id AND c.status = 'active'
           WHERE m.status = 'active' AND m.relationship = 'car_service'`,
        ),
      )
      for (const bad of ['Mother', 'mother,,father', 'mother;drop']) {
        expect((await get(`/api/v1/contacts?relationship=${encodeURIComponent(bad)}`)).statusCode, bad).toBe(400)
      }
    })
  })
})
