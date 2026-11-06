import { describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/config/env.js'

const isolated = { dotenv: false, env: false } as const

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
      data: { NODE_ENV: 'production', DB_HOST: '10.0.0.8' },
    })
    expect(config.nodeEnv).toBe('production')
    expect(config.db.host).toBe('10.0.0.8')
  })

  it('rejects an empty staff type list', async () => {
    await expect(
      loadConfig({ ...isolated, data: { ALLOWED_STAFF_TYPES: ' , ' } }),
    ).rejects.toThrow(/ALLOWED_STAFF_TYPES/)
  })
})
