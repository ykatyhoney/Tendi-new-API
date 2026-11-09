import type { FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'
import type { Pool } from 'mysql2/promise'
import { createFamilyPool } from '../lib/pool.js'

declare module 'fastify' {
  interface FastifyInstance {
    db: Pool
  }
}

/** One promise pool for the family_api account. */
const dbPlugin: FastifyPluginAsync = async (app) => {
  const pool = createFamilyPool(app.config.db)
  app.decorate('db', pool)
  app.addHook('onClose', async () => {
    await pool.end()
  })
}

export default fp(dbPlugin, { name: 'family-db' })
