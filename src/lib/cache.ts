import type { Redis } from 'ioredis'

/**
 * A small key-value cache with expiry. Values are JSON.
 *
 * Every method is fail-open: if the store errors, get() is a miss, set() and del() do nothing, and claim()
 * says yes. A cache outage then costs speed, never correctness, as long as callers treat the cache
 * as optional and the database stays the source of truth.
 *
 * What may be cached: data this API is the only writer of, invalidated after the write commits
 * (relationship types), and throttles (last_seen_at). Never family, contact, or child data: the mirror
 * and the legacy app read those tables directly, and a stale copy would disagree with them.
 */
export interface Cache {
  get<T>(key: string): Promise<T | undefined>
  set(key: string, value: unknown, ttlSeconds: number): Promise<void>
  del(...keys: string[]): Promise<void>
  /** True for the first caller in a ttlSeconds window, false for the rest. SET NX EX in Redis. */
  claim(key: string, ttlSeconds: number): Promise<boolean>
}

export type CacheErrorHandler = (error: unknown, operation: string) => void

/** Shared across every API instance that uses the same Redis. Keys live under `prefix`. */
export class RedisCache implements Cache {
  constructor(
    private readonly redis: Pick<Redis, 'get' | 'set' | 'del'>,
    private readonly prefix: string,
    private readonly onError: CacheErrorHandler = () => undefined,
  ) {}

  async get<T>(key: string): Promise<T | undefined> {
    try {
      const raw = await this.redis.get(this.prefix + key)
      return raw === null ? undefined : (JSON.parse(raw) as T)
    } catch (error) {
      this.onError(error, 'get')
      return undefined
    }
  }

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    try {
      await this.redis.set(this.prefix + key, JSON.stringify(value), 'EX', ttlSeconds)
    } catch (error) {
      this.onError(error, 'set')
    }
  }

  async del(...keys: string[]): Promise<void> {
    if (keys.length === 0) {
      return
    }
    try {
      await this.redis.del(...keys.map((key) => this.prefix + key))
    } catch (error) {
      this.onError(error, 'del')
    }
  }

  async claim(key: string, ttlSeconds: number): Promise<boolean> {
    try {
      return (await this.redis.set(this.prefix + key, '1', 'EX', ttlSeconds, 'NX')) === 'OK'
    } catch (error) {
      this.onError(error, 'claim')
      return true
    }
  }
}

/** One process only. Used without REDIS_URL, and in tests. Oldest entries go first past maxEntries. */
export class MemoryCache implements Cache {
  private readonly entries = new Map<string, { value: string; expiresAt: number }>()

  constructor(
    private readonly maxEntries = 10_000,
    private readonly now: () => number = Date.now,
  ) {}

  async get<T>(key: string): Promise<T | undefined> {
    const entry = this.live(key)
    return entry === undefined ? undefined : (JSON.parse(entry.value) as T)
  }

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    this.put(key, JSON.stringify(value), ttlSeconds)
  }

  async del(...keys: string[]): Promise<void> {
    for (const key of keys) {
      this.entries.delete(key)
    }
  }

  async claim(key: string, ttlSeconds: number): Promise<boolean> {
    if (this.live(key) !== undefined) {
      return false
    }
    this.put(key, '1', ttlSeconds)
    return true
  }

  private live(key: string): { value: string; expiresAt: number } | undefined {
    const entry = this.entries.get(key)
    if (entry !== undefined && entry.expiresAt <= this.now()) {
      this.entries.delete(key)
      return undefined
    }
    return entry
  }

  private put(key: string, value: string, ttlSeconds: number): void {
    this.entries.delete(key)
    this.entries.set(key, { value, expiresAt: this.now() + ttlSeconds * 1000 })
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) {
        break
      }
      this.entries.delete(oldest)
    }
  }
}
