import { describe, expect, it, vi } from 'vitest'
import { MemoryCache, RedisCache } from '../../src/lib/cache.js'

/** The three commands RedisCache uses, with SET's EX and NX options. */
function fakeRedis(failing = false) {
  const store = new Map<string, string>()
  const fail = () => Promise.reject(new Error('Connection is closed.'))
  return {
    store,
    get: (key: string) => (failing ? fail() : Promise.resolve(store.get(key) ?? null)),
    set: (key: string, value: string, ...options: unknown[]) => {
      if (failing) {
        return fail()
      }
      if (options.includes('NX') && store.has(key)) {
        return Promise.resolve(null)
      }
      store.set(key, value)
      return Promise.resolve('OK')
    },
    del: (...keys: string[]) => {
      if (failing) {
        return fail()
      }
      keys.forEach((key) => store.delete(key))
      return Promise.resolve(keys.length)
    },
  }
}

describe('MemoryCache', () => {
  it('returns a value until it expires', async () => {
    let now = 1_000
    const cache = new MemoryCache(100, () => now)
    await cache.set('list', { items: [1, 2] }, 60)
    expect(await cache.get('list')).toEqual({ items: [1, 2] })
    now += 60_000
    expect(await cache.get('list')).toBeUndefined()
  })

  it('lets one caller claim a key per window', async () => {
    let now = 0
    const cache = new MemoryCache(100, () => now)
    expect(await cache.claim('seen:1', 60)).toBe(true)
    expect(await cache.claim('seen:1', 60)).toBe(false)
    now += 60_001
    expect(await cache.claim('seen:1', 60)).toBe(true)
  })

  it('deletes, and drops the oldest entries past its size', async () => {
    const cache = new MemoryCache(2)
    await cache.set('a', 1, 60)
    await cache.set('b', 2, 60)
    await cache.set('c', 3, 60)
    expect(await cache.get('a')).toBeUndefined()
    await cache.del('b')
    expect(await cache.get('b')).toBeUndefined()
    expect(await cache.get('c')).toBe(3)
  })
})

describe('RedisCache', () => {
  it('stores JSON under its prefix and claims with SET NX', async () => {
    const redis = fakeRedis()
    const cache = new RedisCache(redis as never, 'family-api:tendi_family_test:cache:')
    await cache.set('relationship-types:active', { items: [] }, 60)
    expect([...redis.store.keys()]).toEqual(['family-api:tendi_family_test:cache:relationship-types:active'])
    expect(await cache.get('relationship-types:active')).toEqual({ items: [] })
    expect(await cache.claim('last-seen:9', 60)).toBe(true)
    expect(await cache.claim('last-seen:9', 60)).toBe(false)
    await cache.del('relationship-types:active')
    expect(await cache.get('relationship-types:active')).toBeUndefined()
  })

  it('fails open while Redis is down: misses, no-ops, and claims say yes', async () => {
    const onError = vi.fn()
    const cache = new RedisCache(fakeRedis(true) as never, 'p:', onError)
    expect(await cache.get('x')).toBeUndefined()
    await expect(cache.set('x', 1, 60)).resolves.toBeUndefined()
    await expect(cache.del('x')).resolves.toBeUndefined()
    expect(await cache.claim('x', 60)).toBe(true)
    expect(onError).toHaveBeenCalledTimes(4)
  })
})
