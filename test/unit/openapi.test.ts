import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../../src/app.js'
import { loadConfig } from '../../src/config/env.js'
import { ApiError } from '../../src/lib/api-error.js'

type App = Awaited<ReturnType<typeof buildApp>>

const EXPORTED = join(dirname(fileURLToPath(import.meta.url)), '../../openapi/family.json')

describe('OpenAPI contract', () => {
  let app: App

  beforeAll(async () => {
    const config = await loadConfig({ dotenv: false, env: false, data: {} })
    app = await buildApp({ config, logger: false })
    app.get('/api/v1/_probe/conflict', async () => {
      throw new ApiError(409, 'HAS_LINKED_CHILDREN', 'Unlink first.', { childIds: [3, 4] })
    })
    app.get('/api/v1/_probe/crash', async () => {
      throw new Error('select * from secrets')
    })
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
  })

  it('matches openapi/family.json (run npm run export:openapi after changing a route)', async () => {
    const config = await loadConfig({ dotenv: false, env: false, data: {} })
    const clean = await buildApp({ config, logger: false })
    try {
      await clean.ready()
      expect(clean.swagger()).toEqual(JSON.parse(readFileSync(EXPORTED, 'utf8')))
    } finally {
      await clean.close()
    }
  })

  it('documents the shared error body on every route', () => {
    const document = clean(app.swagger()) as {
      components: { schemas: Record<string, unknown> }
      paths: Record<string, Record<string, { responses: Record<string, unknown> }>>
    }
    expect(document.components.schemas['ApiError']).toBeDefined()
    for (const [path, operations] of Object.entries(document.paths)) {
      if (path.includes('_probe')) {
        continue
      }
      for (const [method, operation] of Object.entries(operations)) {
        expect(Object.keys(operation.responses), `${method} ${path}`).toEqual(expect.arrayContaining(['4XX', '5XX']))
      }
    }
  })

  it('names the request and response models under components.schemas and references them', () => {
    const document = clean(app.swagger()) as {
      components: { schemas: Record<string, unknown> }
      paths: Record<string, Record<string, { requestBody?: unknown; responses: Record<string, unknown> }>>
    }
    for (const name of ['Family', 'FamilyMember', 'MemberContact', 'Contact', 'Phone', 'LinkPreview', 'RelationshipType']) {
      expect(document.components.schemas[name], name).toBeDefined()
    }
    const ref = (body: unknown) => (body as { content: { 'application/json': { schema: { $ref?: string } } } }).content['application/json'].schema.$ref
    expect(ref(document.paths['/api/v1/families/{id}']?.['get']?.responses['200'])).toBe('#/components/schemas/Family')
    expect(ref(document.paths['/api/v1/contacts/{id}/phones']?.['put']?.requestBody)).toBe('#/components/schemas/ReplacePhonesBody')
  })

  it('serializes an error with its details through the error schema', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/_probe/conflict' })
    expect(response.statusCode).toBe(409)
    expect(response.json()).toEqual({
      statusCode: 409,
      code: 'HAS_LINKED_CHILDREN',
      error: 'Conflict',
      message: 'Unlink first.',
      details: { childIds: [3, 4] },
    })
  })

  it('serializes a 401 from staff auth and a 500 without internals', async () => {
    const unauthorized = await app.inject({ method: 'GET', url: '/api/v1/families' })
    expect(unauthorized.statusCode).toBe(401)
    expect(unauthorized.json()).toMatchObject({ statusCode: 401, code: 'UNAUTHORIZED' })

    const crash = await app.inject({ method: 'GET', url: '/api/v1/_probe/crash' })
    expect(crash.statusCode).toBe(500)
    expect(crash.json()).toEqual({
      statusCode: 500,
      code: 'INTERNAL',
      error: 'Internal Server Error',
      message: 'Internal server error',
    })
  })
})

/** The document as plain JSON, the way export:openapi writes it. */
function clean(document: unknown): unknown {
  return JSON.parse(JSON.stringify(document))
}
