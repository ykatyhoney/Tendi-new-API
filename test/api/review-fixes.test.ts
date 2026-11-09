import type { RowDataPacket } from 'mysql2/promise'
import mysql from 'mysql2/promise'
import { afterAll, describe, expect, it } from 'vitest'
import { buildApp } from '../../src/app.js'
import { loadConfig } from '../../src/config/env.js'
import { issueDevToken, revokeDevTokens } from '../../scripts/dev-token.js'
import { loadAdminConfig } from '../../scripts/mariadb-admin.js'

/*
 * B12 review fixes, against tendi_family_test: input bounds, name rules, the duplicate-code race,
 * and write responses built inside the save's transaction. Every row this file creates is deleted after.
 */

const TEST_DATABASE = 'tendi_family_test'
const RACE_CODE = 'b_race'

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
const [adminRows] = await connection.query<RowDataPacket[]>(
  `SELECT id FROM admin WHERE status = 'active' AND type = 'admin' ORDER BY id LIMIT 1`,
)
const adminId = Number(adminRows[0]?.['id'])
if (!Number.isInteger(adminId) || adminId < 1) {
  throw new Error('tendi_family_test has no active admin.')
}
const [typeRows] = await connection.query<RowDataPacket[]>(
  `SELECT code FROM relationship_types WHERE status = 'active' AND parent_slot IS NULL ORDER BY sort_order, code LIMIT 1`,
)
const spareType = String(typeRows[0]?.['code'] ?? '')
const token = await issueDevToken(connection, adminId)
const config = await loadConfig()
const app = await buildApp({
  config: { ...config, db: { ...config.db, name: TEST_DATABASE } },
  logger: false,
})
const auth = { authorization: `Bearer ${token}` }
const createdFamilies: number[] = []
const createdContacts: number[] = []

async function createFamily(name: string): Promise<number> {
  const response = await app.inject({ method: 'POST', url: '/api/v1/families', headers: auth, payload: { name } })
  expect(response.statusCode).toBe(200)
  const id = Number(response.json().family.id)
  createdFamilies.push(id)
  return id
}

describe('review fixes against MariaDB', () => {
  afterAll(async () => {
    await deleteCreated()
    await revokeDevTokens(connection, adminId)
    await connection.end()
    await app.close()
  })

  it('refuses a sortOrder outside int(11) with 400 VALIDATION and writes nothing', async () => {
    const familyId = await createFamily('B12 bounds')
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/families/${familyId}/members`,
      headers: auth,
      payload: { relationship: spareType, sortOrder: 3_000_000_000, contact: { fname: 'Out', lname: 'Of Range' } },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().code).toBe('VALIDATION')
    const [members] = await connection.query<RowDataPacket[]>(`SELECT id FROM family_members WHERE family_id = ?`, [familyId])
    expect(members).toHaveLength(0)
  })

  it('trims a new contact\'s names and refuses a contact with no name', async () => {
    const familyId = await createFamily('B12 names')
    const blank = await app.inject({
      method: 'POST',
      url: `/api/v1/families/${familyId}/members`,
      headers: auth,
      payload: { relationship: spareType, contact: { fname: '   ', lname: '' } },
    })
    expect(blank.statusCode).toBe(400)
    expect(blank.json().code).toBe('VALIDATION')

    const padded = await app.inject({
      method: 'POST',
      url: `/api/v1/families/${familyId}/members`,
      headers: auth,
      payload: { relationship: spareType, contact: { fname: '  Bina ', lname: ' Twelve  ' } },
    })
    expect(padded.statusCode).toBe(200)
    const contact = padded.json().family.members[0].contact
    createdContacts.push(Number(contact.id))
    expect(contact).toMatchObject({ fname: 'Bina', lname: 'Twelve', legacyFullName: 'Bina Twelve' })

    const cleared = await app.inject({
      method: 'PATCH',
      url: `/api/v1/contacts/${contact.id}`,
      headers: auth,
      payload: { fname: ' ', lname: '' },
    })
    expect(cleared.statusCode).toBe(400)
    const [stored] = await connection.query<RowDataPacket[]>(`SELECT fname, lname FROM family_contacts WHERE id = ?`, [contact.id])
    expect(stored[0]).toMatchObject({ fname: 'Bina', lname: 'Twelve' })
  })

  it('answers two simultaneous creates of one code with 200 and 409 DUPLICATE_CODE', async () => {
    const create = () =>
      app.inject({
        method: 'POST',
        url: '/api/v1/relationship-types',
        headers: auth,
        payload: { code: RACE_CODE, label: 'B race', sortOrder: 990 },
      })
    const responses = await Promise.all([create(), create(), create()])
    const statuses = responses.map((response) => response.statusCode).sort()
    expect(statuses).toEqual([200, 409, 409])
    for (const response of responses.filter((r) => r.statusCode === 409)) {
      expect(response.json().code).toBe('DUPLICATE_CODE')
    }
  })

  it('returns the state the save committed', async () => {
    const familyId = await createFamily('B12 response')
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/v1/families/${familyId}`,
      headers: auth,
      payload: { name: 'B12 response renamed', householdPhone: '(212) 555-0199' },
    })
    expect(patched.statusCode).toBe(200)
    const read = await app.inject({ method: 'GET', url: `/api/v1/families/${familyId}`, headers: auth })
    expect(read.statusCode).toBe(200)
    expect(patched.json().family).toEqual(read.json())
  })
})

async function deleteCreated(): Promise<void> {
  const list = (ids: readonly number[]) => ids.map(() => '?').join(', ')
  const [memberRows] =
    createdFamilies.length === 0
      ? [[] as RowDataPacket[]]
      : await connection.query<RowDataPacket[]>(
          `SELECT id FROM family_members WHERE family_id IN (${list(createdFamilies)})`,
          createdFamilies,
        )
  const memberIds = memberRows.map((row) => Number(row['id']))
  if (createdFamilies.length > 0) {
    await connection.query(`DELETE FROM family_members WHERE family_id IN (${list(createdFamilies)})`, createdFamilies)
  }
  if (createdContacts.length > 0) {
    await connection.query(`DELETE FROM family_contacts WHERE id IN (${list(createdContacts)})`, createdContacts)
    await connection.query(
      `DELETE FROM audit_logs WHERE table_name = 'family_contacts' AND table_id IN (${list(createdContacts)})`,
      createdContacts,
    )
  }
  if (createdFamilies.length > 0) {
    await connection.query(`DELETE FROM families WHERE id IN (${list(createdFamilies)})`, createdFamilies)
    await connection.query(
      `DELETE FROM audit_logs WHERE table_name = 'families' AND table_id IN (${list(createdFamilies)})`,
      createdFamilies,
    )
  }
  if (memberIds.length > 0) {
    await connection.query(
      `DELETE FROM audit_logs WHERE table_name = 'family_members' AND table_id IN (${list(memberIds)})`,
      memberIds,
    )
  }
  await connection.query(`DELETE FROM relationship_types WHERE code = ?`, [RACE_CODE])
  await connection.query(`DELETE FROM audit_logs WHERE table_name = 'relationship_types' AND entity_name = ?`, [RACE_CODE])
}
