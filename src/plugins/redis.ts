import type { FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'
import { Redis } from 'ioredis'
import { MemoryCache, RedisCache, type Cache } from '../lib/cache.js'

declare module 'fastify' {
  interface FastifyInstance {
    /** The shared client when REDIS_URL is set, else null. Rate limits use it; app code uses app.cache. */
    redis: Redis | null
    cache: Cache
  }
}

/**
 * One Redis client for the app, from REDIS_URL. Without it, or while Redis is down, everything keeps
 * working per process: rate limits let requests through (skipOnError) and the cache misses.
 *
 * Keys start with family-api:<database>:, so a dev server and a test run that share one Redis
 * never read each other's entries.
 */
const redisPlugin: FastifyPluginAsync = async (app) => {
  const url = app.config.redisUrl
  const prefix = redisKeyPrefix(app.config.db.name)
  if (url === null) {
    app.decorate('redis', null)
    app.decorate('cache', new MemoryCache())
    return
  }

  const redis = new Redis(url, {
    // Fail fast while disconnected, so a request never waits on Redis.
    connectTimeout: 1000,
    commandTimeout: 500,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  })

  // An unhandled 'error' event would end the process. One warning per outage, not one per retry or command.
  // The URL can hold a password, so it is never logged.
  let down = false
  const reportDown = (error: unknown) => {
    if (!down) {
      down = true
      const message = error instanceof Error ? error.message : String(error)
      app.log.warn({ err: { message } }, 'Redis is unavailable; rate limits are not shared and caches miss until it is back')
    }
  }
  redis.on('error', reportDown)
  redis.on('ready', () => {
    if (down) {
      down = false
      app.log.info('Redis is reachable again')
    }
  })

  app.decorate('redis', redis)
  app.decorate('cache', new RedisCache(redis, `${prefix}cache:`, reportDown))
  app.addHook('onClose', async () => {
    redis.disconnect()
  })
}

export function redisKeyPrefix(database: string): string {
  return `family-api:${database}:`
}

export default fp(redisPlugin, { name: 'family-redis' })
