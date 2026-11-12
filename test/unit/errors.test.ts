import { createServer } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { buildApp } from '../../src/app.js'
import { loadConfig } from '../../src/config/env.js'

type App = Awaited<ReturnType<typeof buildApp>>

/** A local port that nothing listens on: taken from the system, then given back. */
function closedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

describe('error responses', () => {
  const apps: App[] = []

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()))
  })

  async function open(data: Record<string, unknown> = {}): Promise<App> {
    const config = await loadConfig({ dotenv: false, env: false, data })
    const app = await buildApp({ config, logger: false })
    apps.push(app)
    return app
  }

  it('answers 503 UNAVAILABLE, not 500, while the database cannot be reached', async () => {
    const app = await open({ DB_PORT: await closedPort() })

    const live = await app.inject({ method: 'GET', url: '/api/v1/health/live' })
    expect(live.statusCode).toBe(200)

    const ready = await app.inject({ method: 'GET', url: '/api/v1/health' })
    expect(ready.statusCode).toBe(503)
    expect(ready.json()).toEqual({
      statusCode: 503,
      code: 'UNAVAILABLE',
      error: 'Service Unavailable',
      message: 'The database is not available. Try again shortly.',
    })

    // Staff auth reads the token from the database, so a guarded route fails the same way.
    const guarded = await app.inject({
      method: 'GET',
      url: '/api/v1/families',
      headers: { authorization: 'Bearer any-token' },
    })
    expect(guarded.statusCode).toBe(503)
    expect(guarded.json()).toMatchObject({ code: 'UNAVAILABLE' })
    expect(guarded.body).not.toContain('ECONNREFUSED')
  })

  it("never passes an error's own code on in a 500", async () => {
    const app = await open()
    app.get('/api/v1/_crash', async () => {
      throw Object.assign(new TypeError('The "path" argument must be of type string'), { code: 'ERR_INVALID_ARG_TYPE' })
    })
    const response = await app.inject({ method: 'GET', url: '/api/v1/_crash' })
    expect(response.statusCode).toBe(500)
    expect(response.json()).toEqual({
      statusCode: 500,
      code: 'INTERNAL',
      error: 'Internal Server Error',
      message: 'Internal server error',
    })
  })

  it('names a body that is too large or of a type it does not read', async () => {
    const app = await open()
    app.post('/api/v1/_echo', async () => ({ ok: true }))

    const large = await app.inject({
      method: 'POST',
      url: '/api/v1/_echo',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ note: 'x'.repeat(150 * 1024) }),
    })
    expect(large.statusCode).toBe(413)
    expect(large.json()).toMatchObject({ statusCode: 413, code: 'PAYLOAD_TOO_LARGE', error: 'Payload Too Large' })

    const xml = await app.inject({
      method: 'POST',
      url: '/api/v1/_echo',
      headers: { 'content-type': 'application/xml' },
      payload: '<family/>',
    })
    expect(xml.statusCode).toBe(415)
    expect(xml.json()).toMatchObject({ statusCode: 415, code: 'UNSUPPORTED_MEDIA_TYPE', error: 'Unsupported Media Type' })
  })
})
