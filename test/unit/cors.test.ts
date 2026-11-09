import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../../src/app.js'
import { loadConfig } from '../../src/config/env.js'
import { CORS_METHODS } from '../../src/plugins/security.js'

type App = Awaited<ReturnType<typeof buildApp>>

const ORIGIN = 'http://127.0.0.1:3001'

describe('CORS', () => {
  let app: App

  beforeAll(async () => {
    const config = await loadConfig({ dotenv: false, env: false, data: { CORS_ORIGIN: ORIGIN } })
    app = await buildApp({ config, logger: false })
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
  })

  const preflight = (method: string, origin = ORIGIN) =>
    app.inject({
      method: 'OPTIONS',
      url: '/api/v1/families/1',
      headers: {
        origin,
        'access-control-request-method': method,
        'access-control-request-headers': 'authorization,content-type',
      },
    })

  it('lets Tendi-new send every write method after the preflight', async () => {
    for (const method of ['PATCH', 'PUT', 'DELETE', 'POST']) {
      const response = await preflight(method)
      expect(response.statusCode).toBe(204)
      expect(response.headers['access-control-allow-origin']).toBe(ORIGIN)
      expect(String(response.headers['access-control-allow-methods']).split(',').map((item) => item.trim())).toContain(method)
      expect(String(response.headers['access-control-allow-headers'])).toContain('authorization')
    }
  })

  it('does not allow another origin', async () => {
    const response = await preflight('PATCH', 'https://elsewhere.example')
    expect(response.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('allows every method a route uses', () => {
    const document = app.swagger() as { paths?: Record<string, Record<string, unknown>> }
    const used = new Set(
      Object.values(document.paths ?? {}).flatMap((operations) => Object.keys(operations).map((m) => m.toUpperCase())),
    )
    expect(used.size).toBeGreaterThan(0)
    for (const method of used) {
      expect(CORS_METHODS).toContain(method)
    }
  })
})
