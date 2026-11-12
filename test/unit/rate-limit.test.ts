import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../../src/app.js'
import { loadConfig, type AppConfig } from '../../src/config/env.js'

// Stands in for ioredis: every client shares one in-memory count, the way instances share one Redis.
// It implements the two commands @fastify/rate-limit's RedisStore calls; their Lua is tested upstream.
const fake = vi.hoisted(() => {
  const counts = new Map<string, number>()
  const state = { failing: false, counts }
  class FakeRedis {
    constructor(readonly url: string) {}
    on() {
      return this
    }
    disconnect() {}
    defineCommand() {}
    rateLimit(key: string, timeWindow: number, _max: number, _ce: boolean, _eb: boolean, cb: (err: Error | null, result?: [number, number]) => void) {
      if (state.failing) {
        cb(new Error('Connection is closed.'))
        return
      }
      const current = (counts.get(key) ?? 0) + 1
      counts.set(key, current)
      cb(null, [current, timeWindow])
    }
    rateLimitRead(key: string, cb: (err: Error | null, result?: [number, number]) => void) {
      cb(null, [counts.get(key) ?? 0, 60000])
    }
  }
  return { state, FakeRedis }
})

vi.mock('ioredis', () => ({ Redis: fake.FakeRedis, default: fake.FakeRedis }))

type App = Awaited<ReturnType<typeof buildApp>>

describe('rate limits', () => {
  const apps: App[] = []

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()))
    fake.state.counts.clear()
    fake.state.failing = false
  })

  async function open({ perMinute, redisUrl }: { perMinute: number; redisUrl: AppConfig['redisUrl'] }): Promise<App> {
    const config = await loadConfig({ dotenv: false, env: false, data: {} })
    const app = await buildApp({ config: { ...config, rateLimit: { perMinute }, redisUrl }, logger: false })
    app.get('/api/v1/_probe', async () => ({ ok: true }))
    apps.push(app)
    return app
  }

  const probe = (app: App, headers: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url: '/api/v1/_probe', headers })

  it('shares one count across instances when REDIS_URL is set', async () => {
    const shared = { perMinute: 2, redisUrl: 'redis://cache.internal:6379' }
    const first = await open(shared)
    const second = await open(shared)

    expect((await probe(first)).statusCode).toBe(200)
    expect((await probe(first)).statusCode).toBe(200)
    const limited = await probe(second)
    expect(limited.statusCode).toBe(429)
    expect(limited.json()).toMatchObject({ code: 'RATE_LIMIT' })
  })

  it('keys the token limit by the token hash, never the raw token', async () => {
    const app = await open({ perMinute: 50, redisUrl: 'redis://cache.internal:6379' })
    await probe(app, { authorization: 'Bearer raw-secret-token' })
    const keys = [...fake.state.counts.keys()]
    expect(keys.some((key) => key.includes('token:'))).toBe(true)
    expect(keys.every((key) => key.startsWith('family-api:tendi_family_dev:rate-limit:'))).toBe(true)
    expect(keys.some((key) => key.includes('raw-secret-token'))).toBe(false)
  })

  it('lets requests through while Redis is unreachable', async () => {
    fake.state.failing = true
    const app = await open({ perMinute: 1, redisUrl: 'redis://cache.internal:6379' })
    expect((await probe(app)).statusCode).toBe(200)
    expect((await probe(app)).statusCode).toBe(200)
  })

  it('tells a limited token how long to wait, as the per-address limit does', async () => {
    const app = await open({ perMinute: 1, redisUrl: null })
    const headers = { authorization: 'Bearer one-staff-token' }
    expect((await probe(app, headers)).statusCode).toBe(200)

    const limited = await probe(app, headers)
    expect(limited.statusCode).toBe(429)
    expect(limited.json()).toMatchObject({ code: 'RATE_LIMIT', message: expect.stringContaining('for this token') })
    const seconds = Number(limited.headers['retry-after'])
    expect(seconds).toBeGreaterThan(0)
    expect(seconds).toBeLessThanOrEqual(60)
  })

  it('counts per process without a Redis URL', async () => {
    const local = { perMinute: 1, redisUrl: null }
    const first = await open(local)
    const second = await open(local)
    expect((await probe(first)).statusCode).toBe(200)
    expect((await probe(first)).statusCode).toBe(429)
    expect((await probe(second)).statusCode).toBe(200)
    expect(fake.state.counts.size).toBe(0)
  })
})
