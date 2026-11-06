import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import fp from 'fastify-plugin'
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { ApiError } from '../lib/api-error.js'
import { readBearerToken } from '../lib/bearer.js'
import { tokenHash } from '../lib/token-hash.js'

export interface Staff {
  adminId: number
  type: string
  name: string
}

interface StaffRow extends RowDataPacket {
  adminId: number
  type: string | null
  status: string
  fname: string
  lname: string
  tokenId: number
}

declare module 'fastify' {
  interface FastifyRequest {
    staff?: Staff
  }
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>
    requireRelationshipAdmin: (request: FastifyRequest, reply: FastifyReply) => Promise<void>
  }
}

const authPlugin: FastifyPluginAsync = async (app) => {
  app.decorate('authenticate', async (request: FastifyRequest) => {
    const token = readBearerToken(request.headers.authorization)
    if (token === undefined) {
      throw new ApiError(401, 'UNAUTHORIZED', 'A staff bearer token is required')
    }

    const [rows] = await app.db.query<StaffRow[]>(
      `SELECT a.id AS adminId, a.type AS type, a.status AS status, a.fname AS fname, a.lname AS lname, t.id AS tokenId
       FROM admin_api_tokens AS t
       INNER JOIN admin AS a ON a.id = t.admin_id
       WHERE t.token_hash = :tokenHash
       LIMIT 1`,
      { tokenHash: tokenHash(token) },
    )
    const row = rows[0]
    if (row === undefined) {
      throw new ApiError(401, 'UNAUTHORIZED', 'Unknown token')
    }
    if (row.status !== 'active') {
      throw new ApiError(401, 'UNAUTHORIZED', 'This account is not active')
    }
    if (row.type === null || !app.config.allowedStaffTypes.includes(row.type)) {
      throw new ApiError(403, 'FORBIDDEN', 'This staff type cannot use the Family API')
    }

    const staff: Staff = {
      adminId: Number(row.adminId),
      type: row.type,
      name: `${row.fname} ${row.lname}`.trim(),
    }
    request.staff = staff
    request.log = request.log.child({ staffId: staff.adminId })

    const [updated] = await app.db.query<ResultSetHeader>(
      'UPDATE admin_api_tokens SET last_seen_at = UTC_TIMESTAMP() WHERE id = :tokenId',
      { tokenId: row.tokenId },
    )
    if (updated.affectedRows !== 1) {
      throw new ApiError(401, 'UNAUTHORIZED', 'Unknown token')
    }
  })

  app.decorate('requireRelationshipAdmin', async (request: FastifyRequest) => {
    const staff = request.staff
    if (staff === undefined) {
      throw new ApiError(401, 'UNAUTHORIZED', 'A staff bearer token is required')
    }
    if (!app.config.relationshipAdminTypes.includes(staff.type)) {
      throw new ApiError(403, 'FORBIDDEN', 'This action is limited to relationship admins')
    }
  })
}

export default fp(authPlugin, { name: 'family-auth', dependencies: ['family-db'] })
