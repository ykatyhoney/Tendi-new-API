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

/** Staff types are compared lowercased and trimmed, on both the configured lists and admin.type. */
export function staffType(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase()
}

/** last_seen_at is refreshed when it is older than this. */
const LAST_SEEN_INTERVAL_SECONDS = 60

const authPlugin: FastifyPluginAsync = async (app) => {
  const allowedStaffTypes = new Set(app.config.allowedStaffTypes.map(staffType))
  const relationshipAdminTypes = new Set(app.config.relationshipAdminTypes.map(staffType))

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
    const type = staffType(row.type)
    if (type.length === 0 || !allowedStaffTypes.has(type)) {
      throw new ApiError(403, 'FORBIDDEN', 'This staff type cannot use the Family API')
    }

    const staff: Staff = {
      adminId: Number(row.adminId),
      type,
      name: `${row.fname} ${row.lname}`.trim(),
    }
    request.staff = staff
    request.log = request.log.child({ staffId: staff.adminId })

    // At most one write per token per minute. The claim is shared through Redis, so most requests skip
    // the UPDATE entirely; the WHERE clause still guards when the claim is per process (no Redis, or an
    // outage, where claim() says yes). The token lookup above is never cached: a revoked token or a
    // deactivated account is refused on its next request.
    if (await app.cache.claim(`last-seen:${row.tokenId}`, LAST_SEEN_INTERVAL_SECONDS)) {
      try {
        await app.db.query<ResultSetHeader>(
          `UPDATE admin_api_tokens SET last_seen_at = UTC_TIMESTAMP()
           WHERE id = :tokenId
             AND (last_seen_at IS NULL OR last_seen_at < UTC_TIMESTAMP() - INTERVAL ${LAST_SEEN_INTERVAL_SECONDS} SECOND)`,
          { tokenId: row.tokenId },
        )
      } catch (error) {
        // Bookkeeping only. The token and the account are already checked, so a write that fails here
        // (a lock wait on the token row, a missing grant) must not turn a valid request into an error.
        request.log.warn({ err: error }, 'last_seen_at could not be recorded for the staff token')
      }
    }
  })

  app.decorate('requireRelationshipAdmin', async (request: FastifyRequest) => {
    const staff = request.staff
    if (staff === undefined) {
      throw new ApiError(401, 'UNAUTHORIZED', 'A staff bearer token is required')
    }
    if (!relationshipAdminTypes.has(staffType(staff.type))) {
      throw new ApiError(403, 'FORBIDDEN', 'This action is limited to relationship admins')
    }
  })
}

export default fp(authPlugin, { name: 'family-auth', dependencies: ['family-db', 'family-redis'] })
