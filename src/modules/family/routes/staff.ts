import type { FastifyRequest } from 'fastify'
import { ApiError } from '../../../lib/api-error.js'

/** The signed-in staff member's admin id. Staff auth runs before every route that calls this. */
export function staffId(request: FastifyRequest): number {
  if (request.staff === undefined) {
    throw new ApiError(401, 'UNAUTHORIZED', 'A staff bearer token is required')
  }
  return request.staff.adminId
}
