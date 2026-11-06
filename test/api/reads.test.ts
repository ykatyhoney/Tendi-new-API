import type { RowDataPacket } from 'mysql2/promise'
import mysql from 'mysql2/promise'
import { afterAll, describe, expect, it } from 'vitest'
import { buildApp } from '../../src/app.js'
import { loadConfig } from '../../src/config/env.js'
import { PHONE_LOOKUP_SQL } from '../../src/modules/family/repositories/phones.js'
import { issueDevToken, revokeDevTokens } from '../../scripts/dev-token.js'
import { loadAdminConfig } from '../../scripts/mariadb-admin.js'

const TEST_DATABASE = 'tendi_family_test'

interface Sample {
  familyId: number
  familyName: string
  contactId: number
  contactLname: string
  childId: number
  phoneKey: string
  draftChildId: number
  otherFamilyId: number
}

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
const sample = await loadSample(connection)
const [adminRows] = await connection.query<RowDataPacket[]>(
  `SELECT id FROM admin WHERE status = 'active' AND type = 'admin' ORDER BY id LIMIT 1`,
)
const adminId = Number(adminRows[0]?.['id'])
if (!Number.isInteger(adminId) || adminId < 1) {
  throw new Error('tendi_family_test has no active admin.')
}
const token = await issueDevToken(connection, adminId)
const config = await loadConfig()
const app = await buildApp({
  config: { ...config, db: { ...config.db, name: TEST_DATABASE } },
  logger: false,
})

describe('family reads', () => {
  const auth = { authorization: `Bearer ${token}` }

  afterAll(async () => {
    await connection.query(`UPDATE families SET status = 'active' WHERE id IN (?, ?)`, [
      sample.familyId,
      sample.otherFamilyId,
    ])
    await revokeDevTokens(connection, adminId)
    await connection.end()
    await app.close()
  })

  it('pages active families and finds one by name, phone, and household phone', async () => {
    const listed = await app.inject({ method: 'GET', url: '/api/v1/families', headers: auth })
    expect(listed.statusCode).toBe(200)
    const page = listed.json()
    const [counts] = await connection.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS total FROM families WHERE status = 'active'`,
    )
    expect(page.total).toBe(Number(counts[0]?.['total']))
    expect(page.page).toBe(1)
    expect(page.pageSize).toBe(25)
    expect(page.items).toHaveLength(Math.min(25, page.total))
    expect(page.items[0].memberCount).toBe(page.items[0].members.length)
    expect(page.items[0].childCount).toBe(page.items[0].children.length)

    const byName = await findFamily(sample.familyName, sample.familyId)
    expect(byName).toBeDefined()

    const byPhone = await findFamily(sample.phoneKey, sample.familyId)
    expect(byPhone).toMatchObject({ id: sample.familyId })

    const [before] = await connection.query<RowDataPacket[]>(
      `SELECT household_phone AS phone FROM families WHERE id = ?`,
      [sample.familyId],
    )
    try {
      await connection.query(`UPDATE families SET household_phone = ? WHERE id = ?`, [
        '(999) 999-0001',
        sample.familyId,
      ])
      const found = await findFamily('(999) 999-0001', sample.familyId)
      expect(found?.householdPhone).toBe('(999) 999-0001')
    } finally {
      await connection.query(`UPDATE families SET household_phone = ? WHERE id = ?`, [
        before[0]?.['phone'] ?? '',
        sample.familyId,
      ])
    }
  })

  it('uses idx_fcp_norm for the phone lookup', async () => {
    const [explained] = await app.db.query<RowDataPacket[]>(`EXPLAIN ${PHONE_LOOKUP_SQL}`, [sample.phoneKey])
    const plan = explained[0]
    expect(plan?.['key'], JSON.stringify(explained)).toBe('idx_fcp_norm')
    expect(plan?.['table']).toBe('p')
  })

  it('returns the household, its contacts, children, and rights', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/families/${sample.familyId}`,
      headers: auth,
    })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body).toMatchObject({ id: sample.familyId, name: sample.familyName, status: 'active' })
    expect(body.members.length).toBeGreaterThan(0)
    expect(body.children.some((child: { id: number }) => child.id === sample.childId)).toBe(true)
    const member = body.members.find((item: { contact: { id: number } }) => item.contact.id === sample.contactId)
    expect(member).toBeDefined()
    expect(member.relationshipLabel.length).toBeGreaterThan(0)
    const rights = body.members.flatMap((item: { rights: { childId: number }[] }) => item.rights)
    expect(rights.some((row: { childId: number }) => row.childId === sample.childId)).toBe(true)
  })

  it('returns 404 for an unknown family and a trashed family', async () => {
    const missing = await app.inject({ method: 'GET', url: '/api/v1/families/999999999', headers: auth })
    expect(missing.statusCode).toBe(404)
    expect(missing.json()).toMatchObject({ code: 'NOT_FOUND' })

    await connection.query(`UPDATE families SET status = 'trash' WHERE id = ?`, [sample.otherFamilyId])
    const trashed = await app.inject({
      method: 'GET',
      url: `/api/v1/families/${sample.otherFamilyId}`,
      headers: auth,
    })
    expect(trashed.statusCode).toBe(404)
    await connection.query(`UPDATE families SET status = 'active' WHERE id = ?`, [sample.otherFamilyId])
  })

  it('finds a contact and lists every active household', async () => {
    const listed = await app.inject({
      method: 'GET',
      url: `/api/v1/contacts?q=${encodeURIComponent(sample.contactLname)}&pageSize=100`,
      headers: auth,
    })
    expect(listed.statusCode).toBe(200)
    const match = listed.json().items.find((item: { id: number }) => item.id === sample.contactId)
    expect(match).toBeDefined()
    expect(match.households.some((house: { familyId: number }) => house.familyId === sample.familyId)).toBe(true)

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/contacts/${sample.contactId}`,
      headers: auth,
    })
    expect(detail.statusCode).toBe(200)
    expect(detail.json().households).toEqual(
      expect.arrayContaining([expect.objectContaining({ familyId: sample.familyId })]),
    )
    expect(JSON.stringify(detail.json())).not.toContain('phone_normalized')

    const missing = await app.inject({ method: 'GET', url: '/api/v1/contacts/999999999', headers: auth })
    expect(missing.statusCode).toBe(404)
    expect(missing.json()).toMatchObject({ code: 'NOT_FOUND' })
  })

  it('returns the linked family and the draft family for a child', async () => {
    const linked = await app.inject({
      method: 'GET',
      url: `/api/v1/children/${sample.childId}/family`,
      headers: auth,
    })
    expect(linked.statusCode).toBe(200)
    expect(linked.json()).toMatchObject({ link: 'linked', family: { id: sample.familyId } })

    const draft = await app.inject({
      method: 'GET',
      url: `/api/v1/children/${sample.draftChildId}/family`,
      headers: auth,
    })
    expect(draft.statusCode).toBe(200)
    expect(draft.json().link).toBe('draft')
    const rights = draft.json().family.members.flatMap((member: { rights: { childId: number }[] }) => member.rights)
    expect(rights.some((row: { childId: number }) => row.childId === sample.draftChildId)).toBe(true)

    const missing = await app.inject({
      method: 'GET',
      url: '/api/v1/children/999999999/family',
      headers: auth,
    })
    expect(missing.statusCode).toBe(404)
    expect(missing.json()).toMatchObject({ code: 'NOT_FOUND' })
  })

  it('lists active relationship types in sort order', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/relationship-types', headers: auth })
    expect(response.statusCode).toBe(200)
    const items = response.json().items as {
      code: string
      sortOrder: number
      status: string
      parentSlot: string | null
    }[]
    expect(items.length).toBeGreaterThan(0)
    expect(items.every((item) => item.status === 'active')).toBe(true)
    const orders = items.map((item) => item.sortOrder)
    expect(orders).toEqual([...orders].sort((a, b) => a - b))
    expect(items.map((item) => item.code)).toEqual(expect.arrayContaining(['father', 'mother', 'step_father', 'step_mother']))
    const father = items.find((item) => item.code === 'father')
    const stepFather = items.find((item) => item.code === 'step_father')
    expect(father?.parentSlot).toBe('father')
    expect(father && stepFather && father.sortOrder < stepFather.sortOrder).toBe(true)
  })

  it('rejects an oversized page and a missing token', async () => {
    const invalid = await app.inject({
      method: 'GET',
      url: '/api/v1/families?pageSize=101',
      headers: auth,
    })
    expect(invalid.statusCode).toBe(400)
    expect(invalid.json()).toMatchObject({ code: 'VALIDATION' })

    const open = await app.inject({ method: 'GET', url: '/api/v1/families' })
    expect(open.statusCode).toBe(401)
    expect(open.json()).toMatchObject({ code: 'UNAUTHORIZED' })
  })

  async function findFamily(q: string, id: number): Promise<{ id: number; householdPhone: string; children: { id: number }[] } | undefined> {
    for (let page = 1; page <= 10; page += 1) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/families?q=${encodeURIComponent(q)}&page=${page}&pageSize=100`,
        headers: auth,
      })
      expect(response.statusCode).toBe(200)
      const body = response.json()
      const found = body.items.find((item: { id: number }) => item.id === id)
      if (found !== undefined) {
        return found
      }
      if (page * 100 >= body.total) {
        return undefined
      }
    }
    return undefined
  }
})

async function loadSample(db: mysql.Connection): Promise<Sample> {
  const [families] = await db.query<RowDataPacket[]>(
    `SELECT f.id AS familyId, f.name AS familyName, c.id AS contactId, c.lname AS contactLname, ch.id AS childId
     FROM families AS f
     INNER JOIN family_members AS m ON m.family_id = f.id AND m.status = 'active'
     INNER JOIN family_contacts AS c ON c.id = m.family_contact_id AND c.status = 'active' AND c.lname <> ''
     INNER JOIN children AS ch ON ch.family_id = f.id AND ch.status <> 'trash'
     INNER JOIN family_member_children AS r ON r.member_id = m.id AND r.child_id = ch.id
     WHERE f.status = 'active'
     ORDER BY f.id
     LIMIT 1`,
  )
  const family = families[0]
  if (family === undefined) {
    throw new Error('tendi_family_test has no active family with a member, a child, and rights.')
  }
  const [phones] = await db.query<RowDataPacket[]>(
    `SELECT p.phone_normalized AS phoneKey
     FROM family_contact_phones AS p
     INNER JOIN family_members AS m ON m.family_contact_id = p.family_contact_id AND m.status = 'active'
     INNER JOIN families AS f ON f.id = m.family_id AND f.status = 'active' AND f.id = ?
     WHERE p.phone_normalized <> ''
     LIMIT 1`,
    [family['familyId']],
  )
  const phoneKey = phones[0]?.['phoneKey']
  if (typeof phoneKey !== 'string' || phoneKey.length === 0) {
    throw new Error(`Family ${String(family['familyId'])} has no normalized phone.`)
  }
  const [drafts] = await db.query<RowDataPacket[]>(
    `SELECT c.id AS childId
     FROM children AS c
     WHERE c.family_id IS NULL
       AND EXISTS (
         SELECT 1
         FROM family_member_children AS r
         INNER JOIN family_members AS m ON m.id = r.member_id AND m.status = 'active'
         INNER JOIN families AS f ON f.id = m.family_id AND f.status = 'active'
         WHERE r.child_id = c.id
       )
     ORDER BY c.id
     LIMIT 1`,
  )
  const draftChildId = drafts[0]?.['childId']
  if (draftChildId === undefined) {
    throw new Error('tendi_family_test has no draft child.')
  }
  const [others] = await db.query<RowDataPacket[]>(
    `SELECT id FROM families WHERE status = 'active' AND id <> ? ORDER BY id LIMIT 1`,
    [family['familyId']],
  )
  const otherFamilyId = others[0]?.['id']
  if (otherFamilyId === undefined) {
    throw new Error('tendi_family_test needs a second active family.')
  }
  return {
    familyId: Number(family['familyId']),
    familyName: String(family['familyName']),
    contactId: Number(family['contactId']),
    contactLname: String(family['contactLname']),
    childId: Number(family['childId']),
    phoneKey: phoneKey,
    draftChildId: Number(draftChildId),
    otherFamilyId: Number(otherFamilyId),
  }
}
