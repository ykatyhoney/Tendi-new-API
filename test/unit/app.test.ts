import { afterEach, describe, expect, it } from 'vitest'
import { buildApp } from '../../src/app.js'
import { loadConfig } from '../../src/config/env.js'

type App = Awaited<ReturnType<typeof buildApp>>

describe('buildApp', () => {
  const apps: App[] = []

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()))
  })

  it('answers requests through inject without listening', async () => {
    const config = await loadConfig({ dotenv: false, env: false, data: {} })
    const app = await buildApp({ config, logger: false })
    apps.push(app)

    const response = await app.inject({ method: 'GET', url: '/api/v1/health' })

    expect(response.statusCode).toBe(404)
    expect(app.config.db.name).toBe('tendi_family_dev')
    expect(app.config.allowedStaffTypes).toEqual(['admin', 'office'])
  })
})
