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

const healthRoutes: FastifyPluginAsync = async (app) => {
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
    async () => {
      await assertFamilySchema(app.db)
      return { status: 'ok' as const, database: 'ready' as const }
    },
  )
}

async function assertFamilySchema(db: Pool): Promise<void> {
  await db.query('SELECT 1 AS ok')

  const [familyIdRows] = (await db.query(
    `SELECT COLUMN_NAME AS name
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'children'
       AND COLUMN_NAME = 'family_id'`,
  )) as [RowDataPacket[], unknown]

  const [tableRows] = (await db.query(
    `SELECT TABLE_NAME AS name
     FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME IN (${FAMILY_MODULE_TABLES.map((name) => `'${name}'`).join(', ')})`,
  )) as [RowDataPacket[], unknown]

  const present = new Set(tableRows.map((row) => String(row['name'])))
  const missing = FAMILY_MODULE_TABLES.filter((name) => !present.has(name))
  if (familyIdRows.length !== 1 || missing.length > 0) {
    throw new ApiError(503, 'SCHEMA', 'The family schema is not ready', {
      familyId: familyIdRows.length === 1,
      missing,
    })
  }
}

export default healthRoutes
