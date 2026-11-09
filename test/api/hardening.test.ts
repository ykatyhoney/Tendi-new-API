import { mkdirSync, writeFileSync } from 'node:fs'
import type { RowDataPacket } from 'mysql2/promise'
import mysql from 'mysql2/promise'
import { afterAll, describe, expect, it } from 'vitest'
import { buildApp } from '../../src/app.js'
import { loadConfig } from '../../src/config/env.js'
import { loadChildren } from '../../src/modules/family/services/mirror/load.js'
import { mirrorDifferences } from '../../src/modules/family/services/mirror/reconcile.js'
import { issueDevToken, revokeDevTokens } from '../../scripts/dev-token.js'
import { loadAdminConfig } from '../../scripts/mariadb-admin.js'

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

const createdFamilies: number[] = []

describe('hardening', () => {
  const auth = { authorization: `Bearer ${token}` }

  afterAll(async () => {
    for (const familyId of createdFamilies) {
      await connection.query(`DELETE FROM audit_logs WHERE table_name = 'families' AND table_id = ?`, [familyId])
      await connection.query(`DELETE FROM families WHERE id = ?`, [familyId])
    }
    await revokeDevTokens(connection, adminId)
    await app.close()
    await connection.end()
  })

  it('lets two concurrent saves of one family both succeed', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/families',
      headers: auth,
      payload: { name: 'B10 Concurrent' },
    })
    expect(created.statusCode).toBe(200)
    const familyId = (created.json() as { family: { id: number } }).family.id
    createdFamilies.push(familyId)

    const [first, second] = await Promise.all([
      app.inject({
        method: 'PATCH',
        url: `/api/v1/families/${familyId}`,
        headers: auth,
        payload: { name: 'B10 One', householdPhone: '5550101' },
      }),
      app.inject({
        method: 'PATCH',
        url: `/api/v1/families/${familyId}`,
        headers: auth,
        payload: { name: 'B10 Two', householdPhone: '5550102' },
      }),
    ])

    expect(first.statusCode).toBe(200)
    expect(second.statusCode).toBe(200)
    const saved = await app.inject({
      method: 'GET',
      url: `/api/v1/families/${familyId}`,
      headers: auth,
    })
    expect(saved.statusCode).toBe(200)
    const family = (saved.json() as { name: string; householdPhone: string })
    expect(['B10 One', 'B10 Two']).toContain(family.name)
    expect(['5550101', '5550102']).toContain(family.householdPhone)
    expect(family.name === 'B10 One' ? '5550101' : '5550102').toBe(family.householdPhone)
  })

  it('saves the largest family in under 300 ms and records the slowest routes', async () => {
    const [largestRows] = await connection.query<RowDataPacket[]>(
      `SELECT family_id AS familyId, COUNT(*) AS childCount
       FROM children
       WHERE family_id IS NOT NULL
       GROUP BY family_id
       ORDER BY childCount DESC, family_id
       LIMIT 1`,
    )
    const familyId = Number(largestRows[0]?.['familyId'])
    const childCount = Number(largestRows[0]?.['childCount'])
    expect(childCount).toBe(9)

    const [childRows] = await connection.query<RowDataPacket[]>(
      `SELECT id FROM children WHERE family_id = ? ORDER BY id LIMIT 1`,
      [familyId],
    )
    const childId = Number(childRows[0]?.['id'])
    const [phoneRows] = await connection.query<RowDataPacket[]>(
      `SELECT household_phone AS phone FROM families WHERE id = ?`,
      [familyId],
    )
    const originalPhone = String(phoneRows[0]?.['phone'] ?? '')
    const marker = originalPhone === '5550199' ? '5550198' : '5550199'

    await app.inject({ method: 'GET', url: `/api/v1/families/${familyId}`, headers: auth })
    await app.inject({
      method: 'GET',
      url: `/api/v1/families/${familyId}/children/${childId}/preview`,
      headers: auth,
    })

    const samples: { route: string; ms: number }[] = []
    const time = async (route: string, run: () => Promise<unknown>): Promise<void> => {
      const started = performance.now()
      await run()
      samples.push({ route, ms: Math.round(performance.now() - started) })
    }

    let saveMs: number | undefined
    try {
      const started = performance.now()
      const saved = await app.inject({
        method: 'PATCH',
        url: `/api/v1/families/${familyId}`,
        headers: auth,
        payload: { householdPhone: marker },
      })
      saveMs = Math.round(performance.now() - started)
      expect(saved.statusCode).toBe(200)
      samples.push({ route: 'PATCH /api/v1/families/:id', ms: saveMs })
    } finally {
      const restored = await app.inject({
        method: 'PATCH',
        url: `/api/v1/families/${familyId}`,
        headers: auth,
        payload: { householdPhone: originalPhone },
      })
      expect(restored.statusCode).toBe(200)
      const [after] = await connection.query<RowDataPacket[]>(
        `SELECT household_phone AS phone FROM families WHERE id = ?`,
        [familyId],
      )
      expect(String(after[0]?.['phone'] ?? '')).toBe(originalPhone)
    }

    await time('GET /api/v1/health', () => app.inject({ method: 'GET', url: '/api/v1/health' }))
    await time('GET /api/v1/families', () =>
      app.inject({ method: 'GET', url: '/api/v1/families?page=1&pageSize=25', headers: auth }),
    )
    await time('GET /api/v1/families?q', () =>
      app.inject({ method: 'GET', url: '/api/v1/families?q=a&pageSize=25', headers: auth }),
    )
    await time('GET /api/v1/families/:id', () =>
      app.inject({ method: 'GET', url: `/api/v1/families/${familyId}`, headers: auth }),
    )
    await time('GET /api/v1/contacts', () =>
      app.inject({ method: 'GET', url: '/api/v1/contacts?page=1&pageSize=25', headers: auth }),
    )
    await time('GET /api/v1/contacts?q', () =>
      app.inject({ method: 'GET', url: '/api/v1/contacts?q=a&pageSize=25', headers: auth }),
    )
    await time('GET /api/v1/children/:childId/family', () =>
      app.inject({ method: 'GET', url: `/api/v1/children/${childId}/family`, headers: auth }),
    )
    await time('GET /api/v1/families/:id/children/:childId/preview', () =>
      app.inject({
        method: 'GET',
        url: `/api/v1/families/${familyId}/children/${childId}/preview`,
        headers: auth,
      }),
    )
    await time('GET /api/v1/relationship-types', () =>
      app.inject({ method: 'GET', url: '/api/v1/relationship-types', headers: auth }),
    )

    if (saveMs === undefined) {
      throw new Error('The save was not timed.')
    }
    const slowest = [...samples].sort((left, right) => right.ms - left.ms).slice(0, 5)
    mkdirSync('results', { recursive: true })
    writeFileSync(
      'results/route-timings.json',
      `${JSON.stringify({ familyId, childCount, saveMs, slowest, samples }, null, 2)}\n`,
    )
    expect(saveMs).toBeLessThan(300)
  })

  it('derives the mirror from the latest rows when a contact save waits behind a member save', async () => {
    // A father in exactly one household, with a mobile, a linked child, and no other father-slot member.
    const [picked] = await connection.query<RowDataPacket[]>(
      `SELECT m.id AS memberId, m.family_id AS familyId, m.family_contact_id AS contactId, MIN(c.id) AS childId
       FROM family_members AS m
       INNER JOIN children AS c ON c.family_id = m.family_id
       WHERE m.relationship = 'father' AND m.status = 'active'
         AND (SELECT COUNT(*) FROM family_members AS x WHERE x.family_contact_id = m.family_contact_id AND x.status = 'active') = 1
         AND EXISTS (SELECT 1 FROM family_contact_phones AS p WHERE p.family_contact_id = m.family_contact_id AND p.type = 'mobile')
         AND NOT EXISTS (
           SELECT 1 FROM family_members AS s
           INNER JOIN relationship_types AS rt ON rt.code = s.relationship
           WHERE s.family_id = m.family_id AND s.status = 'active' AND rt.parent_slot = 'father' AND s.id <> m.id
         )
       GROUP BY m.id
       ORDER BY m.id
       LIMIT 1`,
    )
    const sample = picked[0]
    if (sample === undefined) {
      throw new Error('tendi_family_test has no single-household father with a mobile and a linked child.')
    }
    const familyId = Number(sample['familyId'])
    const memberId = Number(sample['memberId'])
    const contactId = Number(sample['contactId'])
    const childId = Number(sample['childId'])
    const [spare] = await connection.query<RowDataPacket[]>(
      `SELECT code FROM relationship_types WHERE parent_slot IS NULL AND status = 'active' ORDER BY sort_order, code LIMIT 1`,
    )
    const spareType = String(spare[0]?.['code'])

    type Phone = { phone: string; type: string; typeLabel: string | null; channel: string; isPrimary: boolean; sortOrder: number }
    const contact = await app.inject({ method: 'GET', url: `/api/v1/contacts/${contactId}`, headers: auth })
    const original = (contact.json().phones as Phone[]).map((phone) => ({
      phone: phone.phone,
      type: phone.type,
      typeLabel: phone.typeLabel,
      channel: phone.channel,
      isPrimary: phone.isPrimary,
      sortOrder: phone.sortOrder,
    }))
    const changed = original.map((phone) => (phone.type === 'mobile' ? { ...phone, phone: '555-0199' } : phone))
    const differences = async () => mirrorDifferences(await loadChildren(app.db, [childId]))
    expect(await differences()).toEqual([])

    // Hold the household lock so both saves queue behind it: first the member change, then the phone change.
    const holder = await app.db.getConnection()
    try {
      await holder.beginTransaction()
      await holder.query('SELECT id FROM families WHERE id = ? FOR UPDATE', [familyId])
      const memberSave = app.inject({
        method: 'PATCH',
        url: `/api/v1/families/${familyId}/members/${memberId}`,
        headers: auth,
        payload: { relationship: spareType },
      })
      await new Promise((resolve) => setTimeout(resolve, 300))
      const phoneSave = app.inject({
        method: 'PUT',
        url: `/api/v1/contacts/${contactId}/phones`,
        headers: auth,
        payload: { phones: changed },
      })
      await new Promise((resolve) => setTimeout(resolve, 300))
      await holder.commit()
      const [member, phones] = await Promise.all([memberSave, phoneSave])
      expect(member.statusCode).toBe(200)
      expect(phones.statusCode).toBe(200)

      // The phone save must see that this contact is no longer the father.
      expect(await differences()).toEqual([])
    } finally {
      holder.release()
      await app.inject({
        method: 'PATCH',
        url: `/api/v1/families/${familyId}/members/${memberId}`,
        headers: auth,
        payload: { relationship: 'father' },
      })
      await app.inject({
        method: 'PUT',
        url: `/api/v1/contacts/${contactId}/phones`,
        headers: auth,
        payload: { phones: original },
      })
      expect(await differences()).toEqual([])
    }
  })
})
