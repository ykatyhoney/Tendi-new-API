import type { RowDataPacket } from 'mysql2/promise'
import mysql from 'mysql2/promise'
import { afterAll, describe, expect, it } from 'vitest'
import { buildApp } from '../../src/app.js'
import { loadConfig } from '../../src/config/env.js'
import { RELATIONSHIP_TYPES_CACHE_KEY } from '../../src/modules/family/services/relationship-types.js'
import { issueDevToken, revokeDevTokens } from '../../scripts/dev-token.js'
import { loadAdminConfig } from '../../scripts/mariadb-admin.js'

const TEST_DATABASE = 'tendi_family_test'
const TYPE_CODE = 'b_kind'
const LOCKED = ['father', 'mother', 'step_father', 'step_mother']

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
  `SELECT id, type FROM admin WHERE status = 'active' AND type IN ('admin', 'office') ORDER BY type, id`,
)
const adminId = Number(adminRows.find((row) => row['type'] === 'admin')?.['id'])
const officeId = Number(adminRows.find((row) => row['type'] === 'office')?.['id'])
if (!Number.isInteger(adminId) || adminId < 1 || !Number.isInteger(officeId) || officeId < 1) {
  throw new Error('tendi_family_test needs an active admin and an active office account.')
}
const adminToken = await issueDevToken(connection, adminId)
const officeToken = await issueDevToken(connection, officeId)
const config = await loadConfig()
const app = await buildApp({
  config: { ...config, db: { ...config.db, name: TEST_DATABASE } },
  logger: false,
})
const createdFamilies: number[] = []
const createdContacts: number[] = []

describe('relationship types', () => {
  const admin = { authorization: `Bearer ${adminToken}` }
  const office = { authorization: `Bearer ${officeToken}` }

  afterAll(async () => {
    await deleteCreated()
    // The rows above were removed with SQL, behind the API, so drop the cached dropdown too.
    await app.cache.del(RELATIONSHIP_TYPES_CACHE_KEY)
    await revokeDevTokens(connection, adminId)
    await revokeDevTokens(connection, officeId)
    await connection.end()
    await app.close()
  })

  it('lets a relationship admin add a type, and keeps an inactive type off the dropdown', async () => {
    const denied = await app.inject({
      method: 'POST',
      url: '/api/v1/relationship-types',
      headers: office,
      payload: { code: TYPE_CODE, label: 'B kind', sortOrder: 1 },
    })
    expect(denied.statusCode).toBe(403)

    const badCode = await app.inject({
      method: 'POST',
      url: '/api/v1/relationship-types',
      headers: admin,
      payload: { code: 'B_Kind', label: 'B kind', sortOrder: 1 },
    })
    expect(badCode.statusCode).toBe(400)
    expect(badCode.json().code).toBe('VALIDATION')

    const [auditBefore] = await connection.query<RowDataPacket[]>(`SELECT COALESCE(MAX(id), 0) AS id FROM audit_logs`)
    const auditStart = Number(auditBefore[0]?.['id'])
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/relationship-types',
      headers: admin,
      payload: { code: TYPE_CODE, label: 'B kind', sortOrder: 1 },
    })
    expect(created.statusCode).toBe(200)
    expect(created.json().relationshipType).toMatchObject({
      code: TYPE_CODE,
      label: 'B kind',
      parentSlot: null,
      slotRank: null,
      sortOrder: 1,
      status: 'active',
    })
    expect(created.json().affected_child_ids).toEqual([])

    const duplicate = await app.inject({
      method: 'POST',
      url: '/api/v1/relationship-types',
      headers: admin,
      payload: { code: TYPE_CODE, label: 'Again', sortOrder: 2 },
    })
    expect(duplicate.statusCode).toBe(409)
    expect(duplicate.json().code).toBe('DUPLICATE_CODE')

    const [audit] = await connection.query<RowDataPacket[]>(
      `SELECT action, col_name, entity_name, table_id, actor_type, actor_ref
       FROM audit_logs WHERE table_name = 'relationship_types' AND entity_name = ? AND id > ? ORDER BY id`,
      [TYPE_CODE, auditStart],
    )
    expect(audit.map((row) => row['col_name'])).toEqual(['code', 'label', 'sort_order', 'status'])
    expect(audit.every((row) => row['action'] === 'insert' && row['table_id'] === null)).toBe(true)
    expect(audit.every((row) => row['actor_type'] === 'staff' && row['actor_ref'] === 'tendi-new')).toBe(true)

    const listed = await app.inject({ method: 'GET', url: '/api/v1/relationship-types', headers: admin })
    expect(listed.statusCode).toBe(200)
    expect(listed.json().items[0].code).toBe(TYPE_CODE)
    expect(listed.json().items.every((item: { status: string }) => item.status === 'active')).toBe(true)

    const family = await app.inject({
      method: 'POST',
      url: '/api/v1/families',
      headers: admin,
      payload: { name: 'B8 Types' },
    })
    expect(family.statusCode).toBe(200)
    const familyId = family.json().family.id
    createdFamilies.push(familyId)
    const member = await app.inject({
      method: 'POST',
      url: `/api/v1/families/${familyId}/members`,
      headers: admin,
      payload: { relationship: TYPE_CODE, contact: { fname: 'B', lname: 'Kind' } },
    })
    expect(member.statusCode).toBe(200)
    createdContacts.push(member.json().family.members[0].contact.id)

    const inactive = await app.inject({
      method: 'PATCH',
      url: `/api/v1/relationship-types/${TYPE_CODE}`,
      headers: admin,
      payload: { status: 'inactive' },
    })
    expect(inactive.statusCode).toBe(200)
    expect(inactive.json().relationshipType.status).toBe('inactive')

    const hidden = await app.inject({ method: 'GET', url: '/api/v1/relationship-types', headers: admin })
    expect(hidden.json().items.some((item: { code: string }) => item.code === TYPE_CODE)).toBe(false)
    const kept = await app.inject({ method: 'GET', url: `/api/v1/families/${familyId}`, headers: admin })
    expect(kept.json().members[0].relationship).toBe(TYPE_CODE)

    const rejected = await app.inject({
      method: 'POST',
      url: `/api/v1/families/${familyId}/members`,
      headers: admin,
      payload: { relationship: TYPE_CODE, contact: { fname: 'B', lname: 'Again' } },
    })
    expect(rejected.statusCode).toBe(400)
    expect(rejected.json().code).toBe('UNKNOWN_RELATIONSHIP')

    const missing = await app.inject({
      method: 'PATCH',
      url: '/api/v1/relationship-types/not_a_code',
      headers: admin,
      payload: { label: 'Nope' },
    })
    expect(missing.statusCode).toBe(404)
    const empty = await app.inject({
      method: 'PATCH',
      url: `/api/v1/relationship-types/${TYPE_CODE}`,
      headers: admin,
      payload: {},
    })
    expect(empty.statusCode).toBe(400)
  })

  it('refuses to rename or deactivate the four parent types', async () => {
    for (const code of LOCKED) {
      const [before] = await connection.query<RowDataPacket[]>(
        `SELECT label, status, sort_order AS sortOrder FROM relationship_types WHERE code = ?`,
        [code],
      )
      const renamed = await app.inject({
        method: 'PATCH',
        url: `/api/v1/relationship-types/${code}`,
        headers: admin,
        payload: { label: 'Changed' },
      })
      expect(renamed.statusCode).toBe(409)
      expect(renamed.json().code).toBe('LOCKED_TYPE')
      const deactivated = await app.inject({
        method: 'PATCH',
        url: `/api/v1/relationship-types/${code}`,
        headers: admin,
        payload: { status: 'inactive' },
      })
      expect(deactivated.statusCode).toBe(409)
      expect(deactivated.json().code).toBe('LOCKED_TYPE')
      const [after] = await connection.query<RowDataPacket[]>(
        `SELECT label, status, sort_order AS sortOrder FROM relationship_types WHERE code = ?`,
        [code],
      )
      expect(after[0]).toMatchObject({
        label: before[0]?.['label'],
        status: before[0]?.['status'],
        sortOrder: before[0]?.['sortOrder'],
      })
    }

    const [father] = await connection.query<RowDataPacket[]>(
      `SELECT sort_order AS sortOrder, label FROM relationship_types WHERE code = 'father'`,
    )
    const sortOrder = Number(father[0]?.['sortOrder'])
    const label = String(father[0]?.['label'])
    try {
      const moved = await app.inject({
        method: 'PATCH',
        url: '/api/v1/relationship-types/father',
        headers: admin,
        payload: { sortOrder: sortOrder + 1 },
      })
      expect(moved.statusCode).toBe(200)
      expect(moved.json().relationshipType).toMatchObject({ label, status: 'active', sortOrder: sortOrder + 1 })
    } finally {
      await connection.query(`UPDATE relationship_types SET sort_order = ? WHERE code = 'father'`, [sortOrder])
    }
  })
})

async function deleteCreated(): Promise<void> {
  if (createdContacts.length > 0) {
    await connection.query(
      `DELETE FROM family_members WHERE family_contact_id IN (${createdContacts.map(() => '?').join(', ')})`,
      createdContacts,
    )
    await connection.query(
      `DELETE FROM family_contacts WHERE id IN (${createdContacts.map(() => '?').join(', ')})`,
      createdContacts,
    )
  }
  if (createdFamilies.length > 0) {
    await connection.query(
      `DELETE FROM family_members WHERE family_id IN (${createdFamilies.map(() => '?').join(', ')})`,
      createdFamilies,
    )
    await connection.query(
      `DELETE FROM families WHERE id IN (${createdFamilies.map(() => '?').join(', ')})`,
      createdFamilies,
    )
  }
  await connection.query(`DELETE FROM relationship_types WHERE code = ?`, [TYPE_CODE])
  await connection.query(`DELETE FROM audit_logs WHERE table_name = 'relationship_types' AND entity_name = ?`, [TYPE_CODE])
}
