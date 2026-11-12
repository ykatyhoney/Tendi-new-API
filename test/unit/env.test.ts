import { describe, expect, it } from 'vitest'
import { configWarnings, loadConfig } from '../../src/config/env.js'

const isolated = { dotenv: false, env: false } as const
const productionSettings = { FAMILY_DB_PASSWORD: 'secret', CORS_ORIGIN: 'https://tendi.example' }

describe('loadConfig', () => {
  it('applies the local defaults when no environment is set', async () => {
    const config = await loadConfig({ ...isolated, data: {} })

    expect(config).toMatchObject({
      nodeEnv: 'development',
      port: 3000,
      host: '127.0.0.1',
      logLevel: 'info',
      db: {
        host: '127.0.0.1',
        port: 3306,
        name: 'tendi_family_dev',
        user: 'family_api',
        password: '',
        poolSize: 10,
      },
      corsOrigins: ['http://127.0.0.1:3001'],
      allowedStaffTypes: ['admin', 'office'],
      relationshipAdminTypes: ['admin', 'superadmin'],
      trustProxy: false,
    })
  })

  it('accepts localhost as a database host', async () => {
    const config = await loadConfig({ ...isolated, data: { DB_HOST: 'localhost' } })
    expect(config.db.host).toBe('localhost')
  })

  it('trims staff type lists', async () => {
    const config = await loadConfig({
      ...isolated,
      data: { ALLOWED_STAFF_TYPES: ' admin , office ' },
    })
    expect(config.allowedStaffTypes).toEqual(['admin', 'office'])
  })

  it('refuses a remote database host outside production', async () => {
    await expect(
      loadConfig({
        ...isolated,
        data: { NODE_ENV: 'development', DB_HOST: '10.0.0.8' },
      }),
    ).rejects.toThrow(/DB_HOST must be 127\.0\.0\.1 or localhost/)
  })

  it('allows a remote database host in production', async () => {
    const config = await loadConfig({
      ...isolated,
      data: { NODE_ENV: 'production', DB_HOST: '10.0.0.8', ...productionSettings },
    })
    expect(config.nodeEnv).toBe('production')
    expect(config.db.host).toBe('10.0.0.8')
  })

  it('requires a database password and a non-local CORS origin in production', async () => {
    await expect(
      loadConfig({ ...isolated, data: { NODE_ENV: 'production', CORS_ORIGIN: productionSettings.CORS_ORIGIN } }),
    ).rejects.toThrow(/FAMILY_DB_PASSWORD must be set/)
    await expect(
      loadConfig({ ...isolated, data: { NODE_ENV: 'production', FAMILY_DB_PASSWORD: 'secret' } }),
    ).rejects.toThrow(/CORS_ORIGIN must not list a local origin/)
    await expect(
      loadConfig({ ...isolated, data: { NODE_ENV: 'production', FAMILY_DB_PASSWORD: 'secret', CORS_ORIGIN: ' , ' } }),
    ).rejects.toThrow(/CORS_ORIGIN must list/)
  })

  it('defaults to 300 a minute in process memory, and accepts only a redis URL for a shared store', async () => {
    const local = await loadConfig({ ...isolated, data: {} })
    expect(local.rateLimit).toEqual({ perMinute: 300 })
    expect(local.redisUrl).toBeNull()
    const shared = await loadConfig({
      ...isolated,
      data: { RATE_LIMIT_PER_MINUTE: '120', REDIS_URL: ' rediss://cache.internal:6380/0 ' },
    })
    expect(shared.rateLimit).toEqual({ perMinute: 120 })
    expect(shared.redisUrl).toBe('rediss://cache.internal:6380/0')
    await expect(
      loadConfig({ ...isolated, data: { REDIS_URL: 'cache.internal:6379' } }),
    ).rejects.toThrow(/REDIS_URL must be a redis/)
  })

  it('reads TRUST_PROXY as off, on, a hop count, or a list of proxies', async () => {
    const read = async (value: string) =>
      (await loadConfig({ ...isolated, data: { TRUST_PROXY: value } })).trustProxy
    expect(await read('')).toBe(false)
    expect(await read('false')).toBe(false)
    expect(await read('true')).toBe(true)
    expect(await read('2')).toBe(2)
    expect(await read('10.0.0.1, 10.0.0.0/8')).toEqual(['10.0.0.1', '10.0.0.0/8'])
  })

  it('rejects an empty staff type list', async () => {
    await expect(
      loadConfig({ ...isolated, data: { ALLOWED_STAFF_TYPES: ' , ' } }),
    ).rejects.toThrow(/ALLOWED_STAFF_TYPES/)
  })
})

describe('configWarnings', () => {
  it('warns when a relationship-admin type cannot get past staff auth', async () => {
    const config = await loadConfig({ ...isolated, data: {} })
    const warnings = configWarnings(config)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('superadmin')
  })

  it('warns when production has no shared Redis', async () => {
    const config = await loadConfig({
      ...isolated,
      data: {
        ...productionSettings,
        NODE_ENV: 'production',
        ALLOWED_STAFF_TYPES: 'admin,superadmin',
      },
    })
    expect(configWarnings(config)).toEqual([expect.stringContaining('REDIS_URL is not set')])
    expect(configWarnings({ ...config, redisUrl: 'redis://cache.internal:6379' })).toEqual([])
  })

  it('warns about a CORS_ORIGIN entry that no browser origin can equal', async () => {
    const staff = { ALLOWED_STAFF_TYPES: 'admin,office,superadmin' }
    const read = async (origins: string) =>
      configWarnings(await loadConfig({ ...isolated, data: { ...staff, CORS_ORIGIN: origins } }))

    expect(await read('http://127.0.0.1:3001, https://families.tendi.example')).toEqual([])
    for (const wrong of ['https://families.tendi.example/', 'https://families.tendi.example/admin', 'HTTPS://Families.Tendi.Example', 'http://localhost:80', 'families.tendi.example', '*']) {
      const warnings = await read(`http://127.0.0.1:3001, ${wrong}`)
      expect(warnings, wrong).toHaveLength(1)
      expect(warnings[0], wrong).toContain(`CORS_ORIGIN lists ${wrong},`)
    }
  })

  it('is quiet when every relationship-admin type is a staff type', async () => {
    const config = await loadConfig({
      ...isolated,
      data: { ALLOWED_STAFF_TYPES: 'admin,office,superadmin', RELATIONSHIP_ADMIN_TYPES: 'admin,superadmin' },
    })
    expect(configWarnings(config)).toEqual([])
  })
})

describe('logic fixes: staff types', () => {
  it('F11 lowercases and trims ALLOWED_STAFF_TYPES and RELATIONSHIP_ADMIN_TYPES', async () => {
    const config = await loadConfig({
      ...isolated,
      data: { ALLOWED_STAFF_TYPES: ' Admin , office , SuperAdmin', RELATIONSHIP_ADMIN_TYPES: ' ADMIN , SuperAdmin ' },
    })
    expect(config.allowedStaffTypes).toEqual(['admin', 'office', 'superadmin'])
    expect(config.relationshipAdminTypes).toEqual(['admin', 'superadmin'])
  })
})
