import { mkdirSync, writeFileSync } from 'node:fs'
import type { RowDataPacket } from 'mysql2/promise'
import mysql from 'mysql2/promise'
import { afterAll, describe, expect, it } from 'vitest'
import { buildApp } from '../../src/app.js'
import { loadConfig } from '../../src/config/env.js'
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
})
