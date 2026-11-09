import { Redis } from 'ioredis'
import { redisKeyPrefix } from '../src/plugins/redis.js'

/**
 * Deletes one database's cache entries (family-api:<database>:cache:*). A reset or import replaces the
 * rows a cached value came from, so its entries must go too. Rate-limit counts are left alone.
 * Returns how many keys were removed.
 */
export async function clearDatabaseCache(redisUrl: string, database: string): Promise<number> {
  const redis = new Redis(redisUrl, { connectTimeout: 2000, maxRetriesPerRequest: 1, lazyConnect: true })
  try {
    await redis.connect()
    let removed = 0
    let cursor = '0'
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', `${redisKeyPrefix(database)}cache:*`, 'COUNT', 500)
      cursor = next
      if (keys.length > 0) {
        removed += await redis.del(...keys)
      }
    } while (cursor !== '0')
    return removed
  } finally {
    redis.disconnect()
  }
}
