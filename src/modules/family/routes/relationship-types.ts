import { type FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import type { FastifyRequest } from 'fastify'
import { ApiError } from '../../../lib/api-error.js'
import {
  createRelationshipTypeBody,
  patchRelationshipTypeBody,
  relationshipTypeList,
  relationshipTypeParams,
  relationshipTypeResult,
} from '../schemas/relationship-type.js'
import {
  createRelationshipType,
  listRelationshipTypes,
  patchRelationshipType,
} from '../services/relationship-types.js'

function staffId(request: FastifyRequest): number {
  if (request.staff === undefined) {
    throw new ApiError(401, 'UNAUTHORIZED', 'A staff bearer token is required')
  }
  return request.staff.adminId
}

const relationshipTypeRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    '/api/v1/relationship-types',
    {
      schema: {
        operationId: 'listRelationshipTypes',
        response: { 200: relationshipTypeList },
      },
    },
    async () => listRelationshipTypes(app.db),
  )

  app.post(
    '/api/v1/relationship-types',
    {
      schema: {
        operationId: 'createRelationshipType',
        body: createRelationshipTypeBody,
        response: { 200: relationshipTypeResult },
      },
      preHandler: app.requireRelationshipAdmin,
    },
    async (request) => createRelationshipType(app.db, staffId(request), request.body),
  )

  app.patch(
    '/api/v1/relationship-types/:code',
    {
      schema: {
        operationId: 'patchRelationshipType',
        params: relationshipTypeParams,
        body: patchRelationshipTypeBody,
        response: { 200: relationshipTypeResult },
      },
      preHandler: app.requireRelationshipAdmin,
    },
    async (request) => patchRelationshipType(app.db, staffId(request), request.params.code, request.body),
  )
}

export default relationshipTypeRoutes
