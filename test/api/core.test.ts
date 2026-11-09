import { Type } from '@fastify/type-provider-typebox'
import { afterEach, describe, expect, it } from 'vitest'
import { buildApp } from '../../src/app.js'
import { loadConfig, type AppConfig } from '../../src/config/env.js'

type App = Awaited<ReturnType<typeof buildApp>>

describe('family core', () => {
  const apps: App[] = []

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()))
  })

  it('reports health for the family schema', async () => {
    const app = await open()
    const response = await app.inject({ method: 'GET', url: '/api/v1/health' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ status: 'ok', database: 'ready' })
    expect(response.headers['x-request-id']).toBeTruthy()
  })

  it('returns the request id it was given', async () => {
    const app = await open()
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/health',
      headers: { 'x-request-id': 'health-check-1' },
    })
    expect(response.headers['x-request-id']).toBe('health-check-1')
  })

  it('shows the OpenAPI viewer outside production and hides it in production', async () => {
    const development = await open({ nodeEnv: 'development' })
    const docs = await development.inject({ method: 'GET', url: '/docs/' })
    expect(docs.statusCode).toBe(200)
    expect(docs.body).toContain('swagger')

    const production = await open({ nodeEnv: 'production' })
    const hidden = await production.inject({ method: 'GET', url: '/docs/' })
    expect(hidden.statusCode).toBe(404)
    expect(hidden.json()).toMatchObject({ code: 'NOT_FOUND' })
  })

  it('returns 400 VALIDATION with the field path', async () => {
    const app = await open()
    app.get(
      '/api/v1/_validation',
      {
        schema: {
          operationId: 'getValidationProbe',
          querystring: Type.Object({ page: Type.Integer({ minimum: 1 }) }),
        },
      },
      async () => ({ ok: true }),
    )
    const response = await app.inject({ method: 'GET', url: '/api/v1/_validation?page=no' })
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({
      statusCode: 400,
      code: 'VALIDATION',
      error: 'Bad Request',
      details: [{ path: '/page' }],
    })
  })

  it('accepts an empty JSON body and still rejects invalid JSON', async () => {
    const app = await open()
    app.post('/api/v1/_empty', async (request) => ({ empty: request.body === null || jsonObject(request.body) }))
    app.post(
      '/api/v1/_needs-body',
      { schema: { body: Type.Object({ name: Type.String({ minLength: 1 }) }) } },
      async () => ({ ok: true }),
    )

    const empty = await app.inject({
      method: 'POST',
      url: '/api/v1/_empty',
      headers: { 'content-type': 'application/json' },
      payload: '',
    })
    expect(empty.statusCode).toBe(200)
    expect(empty.json()).toEqual({ empty: true })

    const missing = await app.inject({
      method: 'POST',
      url: '/api/v1/_needs-body',
      headers: { 'content-type': 'application/json' },
      payload: '',
    })
    expect(missing.statusCode).toBe(400)
    expect(missing.json().code).toBe('VALIDATION')

    const invalid = await app.inject({
      method: 'POST',
      url: '/api/v1/_empty',
      headers: { 'content-type': 'application/json' },
      payload: '{',
    })
    expect(invalid.statusCode).toBe(400)
    expect(invalid.json().message).toContain('not valid JSON')
  })

  it('hides SQL when a database error is not a known constraint', async () => {
    const app = await open()
    app.get('/api/v1/_boom', async () => {
      throw Object.assign(new Error('duplicate'), {
        errno: 1062,
        sqlMessage: "Duplicate entry 'a' for key 'uq_admin_token'",
        sql: 'INSERT INTO admin_api_tokens (token_hash) VALUES (\'secret-hash\')',
      })
    })
    const response = await app.inject({ method: 'GET', url: '/api/v1/_boom' })
    expect(response.statusCode).toBe(500)
    expect(response.json()).toMatchObject({ code: 'INTERNAL', message: 'Internal server error' })
    expect(response.body).not.toContain('secret-hash')
    expect(response.body).not.toContain('INSERT')
  })

  function jsonObject(value: unknown): boolean {
    return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length === 0
  }

  async function open(overrides: Partial<AppConfig> = {}): Promise<App> {
    const config = await loadConfig()
    const app = await buildApp({ config: { ...config, ...overrides }, logger: false })
    apps.push(app)
    return app
  }
})
