import type { FastifyPluginAsync } from 'fastify'
import type { Pool, RowDataPacket } from 'mysql2/promise'
import { Type } from '@fastify/type-provider-typebox'
import { ApiError } from '../../../lib/api-error.js'

/** The nine family-module tables. Legacy tables are not part of this list. */
export const FAMILY_MODULE_TABLES = [
  'families',
  'family_contacts',
  'family_contact_phones',
  'family_contact_emails',
  'family_contact_addresses',
  'family_members',
  'family_member_children',
  'relationship_types',
  'family_mirror_lock_log',
] as const

const healthResponse = Type.Object(
  {
    status: Type.Literal('ok'),
    database: Type.Literal('ready'),
  },
  { additionalProperties: false },
)

/** A passed schema check is trusted for this long. The pool is still pinged on every call. */
const SCHEMA_CHECK_TTL_MS = 5 * 60 * 1000

const liveResponse = Type.Object({ status: Type.Literal('ok') }, { additionalProperties: false })

/**
 * /health/live: the process is up. It never touches the database, so a restart policy does not
 * restart a healthy process during a database outage.
 * /health: ready to serve. Pings the pool and checks the family schema; 503 when not ready.
 */
const healthRoutes: FastifyPluginAsync = async (app) => {
  let schemaCheckedAt: number | undefined

  app.get(
    '/api/v1/health/live',
    {
      schema: {
        operationId: 'getLiveness',
        tags: ['family'],
        security: [],
        response: { 200: liveResponse },
      },
    },
    async () => ({ status: 'ok' as const }),
  )

  app.get(
    '/api/v1/health',
    {
      schema: {
        operationId: 'getHealth',
        tags: ['family'],
        security: [],
        response: { 200: healthResponse },
      },
    },
    async (request) => {
      await app.db.query('SELECT 1 AS ok')
      const now = Date.now()
      if (schemaCheckedAt === undefined || now - schemaCheckedAt > SCHEMA_CHECK_TTL_MS) {
        const problem = await familySchemaProblem(app.db)
        if (problem !== null) {
          schemaCheckedAt = undefined
          // Health is open, so which tables are missing goes to the log, not to the caller.
          request.log.error(problem, 'family schema is not ready')
          throw new ApiError(503, 'SCHEMA', 'The family schema is not ready')
        }
        schemaCheckedAt = now
      }
      return { status: 'ok' as const, database: 'ready' as const }
    },
  )
}

/** null when children.family_id and the nine family tables exist. */
export async function familySchemaProblem(
  db: Pool,
): Promise<{ familyId: boolean; missing: string[] } | null> {
  const [familyIdRows] = (await db.query(
    `SELECT COLUMN_NAME AS name
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?
       AND COLUMN_NAME = ?`,
    ['children', 'family_id'],
  )) as [RowDataPacket[], unknown]

  const [tableRows] = (await db.query(
    `SELECT TABLE_NAME AS name
     FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME IN (${FAMILY_MODULE_TABLES.map(() => '?').join(', ')})`,
    [...FAMILY_MODULE_TABLES],
  )) as [RowDataPacket[], unknown]

  const present = new Set(tableRows.map((row) => String(row['name'])))
  const missing = FAMILY_MODULE_TABLES.filter((name) => !present.has(name))
  if (familyIdRows.length !== 1 || missing.length > 0) {
    return { familyId: familyIdRows.length === 1, missing }
  }
  return null
}

export default healthRoutes
