import type { FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'
import mysql, { type Pool } from 'mysql2/promise'

declare module 'fastify' {
  interface FastifyInstance {
    db: Pool
  }
}

/**
 * One promise pool for the family_api account.
 * bit(1) values are returned as 0 or 1. Repositories can also select them as `col + 0`.
 */
const dbPlugin: FastifyPluginAsync = async (app) => {
  const { db } = app.config
  const pool = mysql.createPool({
    host: db.host,
    port: db.port,
    database: db.name,
    user: db.user,
    password: db.password,
    charset: 'utf8mb4',
    dateStrings: true,
    timezone: 'Z',
    supportBigNumbers: true,
    namedPlaceholders: true,
    connectionLimit: db.poolSize,
    typeCast(field, next) {
      if (field.type === 'BIT' && field.length === 1) {
        const value = field.buffer()
        if (value == null || value.length === 0) {
          return null
        }
        return value[0] ?? 0
      }
      return next()
    },
  })

  app.decorate('db', pool)
  app.addHook('onClose', async () => {
    await pool.end()
  })
}

export default fp(dbPlugin, { name: 'family-db' })
