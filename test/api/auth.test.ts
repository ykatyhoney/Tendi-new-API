import { randomBytes } from 'node:crypto'
import type { FastifyPluginAsync } from 'fastify'
import mysql, { type RowDataPacket } from 'mysql2/promise'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../../src/app.js'
import { loadConfig } from '../../src/config/env.js'
import { tokenHash } from '../../src/lib/token-hash.js'
import { issueDevToken, revokeDevTokens } from '../../scripts/dev-token.js'
import { loadAdminConfig } from '../../scripts/mariadb-admin.js'

const TEST_DATABASE = 'tendi_family_test'
const TEST_DEVICE_ID = 'tendi-auth-test'

interface Account {
  id: number
  type: string
  status: string
  name: string
}

const probeRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/v1/_who', async (request) => ({
    adminId: request.staff?.adminId,
    type: request.staff?.type,
    name: request.staff?.name,
  }))
  app.get(
    '/api/v1/_relationship',
    { preHandler: app.requireRelationshipAdmin },
    async () => ({ ok: true }),
  )
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
const accounts = await loadAccounts(connection)
const tokens = new Map<number, string>()
const config = await loadConfig()
const app = await buildApp({
  config: { ...config, db: { ...config.db, name: TEST_DATABASE } },
  logger: false,
  extraRoutes: probeRoutes,
})

describe('staff auth', () => {
  beforeAll(async () => {
    await connection.query('DELETE FROM admin_api_tokens WHERE device_id = ?', [TEST_DEVICE_ID])
    for (const account of [accounts.admin, accounts.office, accounts.teacher, accounts.inactive, accounts.superadmin]) {
      tokens.set(account.id, await insertToken(connection, account.id))
    }
  })

  afterAll(async () => {
    await connection.query('DELETE FROM admin_api_tokens WHERE device_id = ?', [TEST_DEVICE_ID])
    await revokeDevTokens(connection, accounts.admin.id)
    await connection.end()
    await app.close()
  })

  it('accepts an active admin and records last_seen_at', async () => {
    const token = requiredToken(tokens, accounts.admin.id)
    await connection.query(
      'UPDATE admin_api_tokens SET last_seen_at = ? WHERE token_hash = ?',
      ['2000-01-01 00:00:00', tokenHash(token)],
    )
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/_who',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      adminId: accounts.admin.id,
      type: 'admin',
      name: accounts.admin.name,
    })
    const [rows] = await connection.query<RowDataPacket[]>(
      'SELECT last_seen_at AS seen FROM admin_api_tokens WHERE token_hash = ?',
      [tokenHash(token)],
    )
    expect(String(rows[0]?.['seen'])).not.toBe('2000-01-01 00:00:00')
  })

  it('still serves the request when last_seen_at cannot be written', async () => {
    // A new token row, so this request is the one that tries to record last_seen_at.
    const token = await insertToken(connection, accounts.admin.id)
    const realQuery = app.db.query.bind(app.db) as (...args: unknown[]) => Promise<unknown>
    let refusedWrites = 0
    const spy = vi.spyOn(app.db, 'query').mockImplementation(((...args: unknown[]) => {
      if (typeof args[0] === 'string' && args[0].includes('UPDATE admin_api_tokens')) {
        refusedWrites += 1
        return Promise.reject(Object.assign(new Error('Lock wait timeout exceeded'), { errno: 1205 }))
      }
      return realQuery(...args)
    }) as unknown as typeof app.db.query)
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/_who',
        headers: { authorization: `Bearer ${token}` },
      })
      expect(response.statusCode, response.body).toBe(200)
      expect(response.json()).toMatchObject({ adminId: accounts.admin.id, type: 'admin' })
      expect(refusedWrites).toBe(1)
    } finally {
      spy.mockRestore()
    }
  })

  it('lets office staff through and refuses a teacher and a superadmin', async () => {
    const office = await app.inject({
      method: 'GET',
      url: '/api/v1/_who',
      headers: { authorization: `Bearer ${requiredToken(tokens, accounts.office.id)}` },
    })
    expect(office.statusCode).toBe(200)
    expect(office.json()).toMatchObject({ adminId: accounts.office.id, type: 'office' })

    const teacher = await app.inject({
      method: 'GET',
      url: '/api/v1/_who',
      headers: { authorization: `Bearer ${requiredToken(tokens, accounts.teacher.id)}` },
    })
    expect(teacher.statusCode).toBe(403)
    expect(teacher.json()).toMatchObject({ code: 'FORBIDDEN' })

    const superadmin = await app.inject({
      method: 'GET',
      url: '/api/v1/_who',
      headers: { authorization: `Bearer ${requiredToken(tokens, accounts.superadmin.id)}` },
    })
    expect(superadmin.statusCode).toBe(403)
    expect(superadmin.json()).toMatchObject({
      code: 'FORBIDDEN',
      message: 'This staff type cannot use the Family API',
    })
  })

  it('returns 401 for a missing token, an unknown token, and an account that is not active', async () => {
    const missing = await app.inject({ method: 'GET', url: '/api/v1/_who' })
    expect(missing.statusCode).toBe(401)
    expect(missing.json()).toMatchObject({ code: 'UNAUTHORIZED' })

    const unknown = await app.inject({
      method: 'GET',
      url: '/api/v1/_who',
      headers: { authorization: 'Bearer not-a-real-token' },
    })
    expect(unknown.statusCode).toBe(401)
    expect(unknown.json()).toMatchObject({ code: 'UNAUTHORIZED', message: 'Unknown token' })
    expect(unknown.body).not.toContain('not-a-real-token')

    const inactive = await app.inject({
      method: 'GET',
      url: '/api/v1/_who',
      headers: { authorization: `Bearer ${requiredToken(tokens, accounts.inactive.id)}` },
    })
    expect(inactive.statusCode).toBe(401)
    expect(inactive.json()).toMatchObject({ code: 'UNAUTHORIZED', message: 'This account is not active' })
  })

  it('limits relationship-admin routes to relationship admin types', async () => {
    const admin = await app.inject({
      method: 'GET',
      url: '/api/v1/_relationship',
      headers: { authorization: `Bearer ${requiredToken(tokens, accounts.admin.id)}` },
    })
    expect(admin.statusCode).toBe(200)

    const office = await app.inject({
      method: 'GET',
      url: '/api/v1/_relationship',
      headers: { authorization: `Bearer ${requiredToken(tokens, accounts.office.id)}` },
    })
    expect(office.statusCode).toBe(403)
    expect(office.json()).toMatchObject({
      code: 'FORBIDDEN',
      message: 'This action is limited to relationship admins',
    })
  })

  it('leaves health open without a token', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/health' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ status: 'ok', database: 'ready' })
  })

  it('creates a dev token for an active admin and revoke removes it', async () => {
    const token = await issueDevToken(connection, accounts.admin.id)
    const accepted = await app.inject({
      method: 'GET',
      url: '/api/v1/_who',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(accepted.statusCode).toBe(200)
    expect(accepted.json()).toMatchObject({ adminId: accounts.admin.id, type: 'admin' })

    const removed = await revokeDevTokens(connection, accounts.admin.id)
    expect(removed).toBeGreaterThan(0)
    const rejected = await app.inject({
      method: 'GET',
      url: '/api/v1/_who',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(rejected.statusCode).toBe(401)
    expect(rejected.json()).toMatchObject({ code: 'UNAUTHORIZED' })
  })
})

async function loadAccounts(connection: mysql.Connection): Promise<{
  admin: Account
  office: Account
  teacher: Account
  inactive: Account
  superadmin: Account
}> {
  return {
    admin: await oneAccount(connection, 'active', 'admin'),
    office: await oneAccount(connection, 'active', 'office'),
    teacher: await oneAccount(connection, 'active', 'teacher'),
    inactive: await oneAccount(connection, 'not-active'),
    superadmin: await oneAccount(connection, 'active', 'superadmin'),
  }
}

async function oneAccount(
  connection: mysql.Connection,
  status: 'active' | 'not-active',
  type?: string,
): Promise<Account> {
  const filters = [status === 'active' ? "status = 'active'" : "status <> 'active'"]
  const params: string[] = []
  if (type !== undefined) {
    filters.push('type = ?')
    params.push(type)
  }
  const [rows] = await connection.query<RowDataPacket[]>(
    `SELECT id, type, status, fname, lname FROM admin WHERE ${filters.join(' AND ')} ORDER BY id LIMIT 1`,
    params,
  )
  const row = rows[0]
  if (row === undefined) {
    throw new Error(`tendi_family_test has no admin row for ${status} ${type ?? 'any type'}.`)
  }
  return {
    id: Number(row['id']),
    type: String(row['type']),
    status: String(row['status']),
    name: `${String(row['fname'])} ${String(row['lname'])}`.trim(),
  }
}

async function insertToken(connection: mysql.Connection, adminId: number): Promise<string> {
  const token = randomBytes(32).toString('hex')
  await connection.query(
    `INSERT INTO admin_api_tokens (admin_id, token_hash, device_id, app_version, created_at, last_seen_at)
     VALUES (?, ?, ?, 'test', UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
    [adminId, tokenHash(token), TEST_DEVICE_ID],
  )
  return token
}

function requiredToken(tokens: Map<number, string>, adminId: number): string {
  const token = tokens.get(adminId)
  if (token === undefined) {
    throw new Error(`No test token for admin ${adminId}.`)
  }
  return token
}
