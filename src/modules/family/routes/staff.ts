import { type FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import type { FastifyRequest } from 'fastify'
import { ApiError } from '../../../lib/api-error.js'
import { staffType } from '../../../plugins/auth.js'
import { staffMe } from '../schemas/staff.js'

/** The signed-in staff member's admin id. Staff auth runs before every route that calls this. */
export function staffId(request: FastifyRequest): number {
  if (request.staff === undefined) {
    throw new ApiError(401, 'UNAUTHORIZED', 'A staff bearer token is required')
  }
  return request.staff.adminId
}

const staffRoutes: FastifyPluginAsyncTypebox = async (app) => {
  const relationshipAdminTypes = new Set(app.config.relationshipAdminTypes.map(staffType))

  // Staff auth has already refused an unknown token (401) and a type outside ALLOWED_STAFF_TYPES (403).
  app.get(
    '/api/v1/staff/me',
    {
      schema: {
        operationId: 'getCurrentStaff',
        response: { 200: staffMe },
      },
    },
    async (request) => {
      const staff = request.staff
      if (staff === undefined) {
        throw new ApiError(401, 'UNAUTHORIZED', 'A staff bearer token is required')
      }
      return {
        adminId: staff.adminId,
        name: staff.name,
        type: staff.type,
        relationshipAdmin: relationshipAdminTypes.has(staffType(staff.type)),
      }
    },
  )
}

export default staffRoutes
