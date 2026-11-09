import type { RowDataPacket } from 'mysql2/promise'
import mysql from 'mysql2/promise'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../../src/app.js'
import { loadConfig } from '../../src/config/env.js'
import { RELATIONSHIP_TYPES_CACHE_KEY } from '../../src/modules/family/services/relationship-types.js'
import { issueDevToken, revokeDevTokens } from '../../scripts/dev-token.js'
import { loadAdminConfig } from '../../scripts/mariadb-admin.js'

/*
 * Caching and throttling against tendi_family_test, with the Redis in REDIS_URL when it is set
 * (CI and this machine) and the in-process cache otherwise. Both must behave the same within one process.
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
const [adminRows] = await connection.query<RowDataPacket[]>(
  `SELECT id FROM admin WHERE status = 'active' AND type = 'admin' ORDER BY id LIMIT 1`,
)
const adminId = Number(adminRows[0]?.['id'])
const [typeRows] = await connection.query<RowDataPacket[]>(
  `SELECT code, label FROM relationship_types
   WHERE status = 'active' AND parent_slot IS NULL ORDER BY sort_order, code LIMIT 1`,
)
const spare = { code: String(typeRows[0]?.['code']), label: String(typeRows[0]?.['label']) }
const config = await loadConfig()
const app = await buildApp({
  config: { ...config, db: { ...config.db, name: TEST_DATABASE } },
  logger: false,
})

let poolQueries = 0
const countedQuery = app.db.query.bind(app.db)
;(app.db as unknown as { query: (...args: unknown[]) => unknown }).query = (...args: unknown[]) => {
  poolQueries += 1
  return (countedQuery as (...a: unknown[]) => unknown)(...args)
}

async function queriesFor(run: () => Promise<unknown>): Promise<number> {
  poolQueries = 0
  await run()
  return poolQueries
}

describe('Redis-backed cache and throttle', () => {
  let token = ''
  const auth = () => ({ authorization: `Bearer ${token}` })

  beforeAll(async () => {
    await app.ready()
    const redis = app.redis
    if (redis !== null && redis.status !== 'ready') {
      await new Promise<void>((resolve, reject) => {
        redis.once('ready', () => resolve())
        setTimeout(() => reject(new Error('Redis in REDIS_URL did not become ready')), 3000)
      })
    }
    await app.cache.del(RELATIONSHIP_TYPES_CACHE_KEY)
    token = await issueDevToken(connection, adminId)
  })

  afterAll(async () => {
    await connection.query(`UPDATE relationship_types SET label = ? WHERE code = ?`, [spare.label, spare.code])
    await app.cache.del(RELATIONSHIP_TYPES_CACHE_KEY)
    await revokeDevTokens(connection, adminId)
    await connection.end()
    await app.close()
  })

  it('serves a repeat dropdown request with one query, the token lookup', async () => {
    const get = () => app.inject({ method: 'GET', url: '/api/v1/relationship-types', headers: auth() })
    const first = await queriesFor(get)
    const second = await queriesFor(get)
    // First: token lookup, the last_seen_at update, the list. Then the update is claimed and the list cached.
    expect(first).toBe(3)
    expect(second).toBe(1)
    expect((await get()).json().items.length).toBeGreaterThan(0)
  })

  it('shows an edited label on the next read', async () => {
    const renamed = `${spare.label} (B13)`.slice(0, 64)
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/v1/relationship-types/${spare.code}`,
      headers: auth(),
      payload: { label: renamed },
    })
    expect(patched.statusCode).toBe(200)
    const listed = await app.inject({ method: 'GET', url: '/api/v1/relationship-types', headers: auth() })
    const item = (listed.json().items as { code: string; label: string }[]).find((row) => row.code === spare.code)
    expect(item?.label).toBe(renamed)
  })

  it('never caches the token lookup: a revoked token is refused on its next request', async () => {
    const own = await issueDevToken(connection, adminId)
    const headers = { authorization: `Bearer ${own}` }
    expect((await app.inject({ method: 'GET', url: '/api/v1/relationship-types', headers })).statusCode).toBe(200)
    await connection.query(`DELETE FROM admin_api_tokens WHERE token_hash = MD5(?)`, [own])
    expect((await app.inject({ method: 'GET', url: '/api/v1/relationship-types', headers })).statusCode).toBe(401)
  })

  it('keeps every key under this database name', async () => {
    const redis = app.redis
    if (redis === null) {
      return
    }
    const keys = await redis.keys('family-api:*')
    expect(keys.length).toBeGreaterThan(0)
    for (const key of keys.filter((name) => name.includes(':cache:'))) {
      expect(key.startsWith(`family-api:${TEST_DATABASE}:`) || key.startsWith('family-api:tendi_family_dev:')).toBe(true)
    }
    expect(keys).toContain(`family-api:${TEST_DATABASE}:cache:${RELATIONSHIP_TYPES_CACHE_KEY}`)
  })
})
