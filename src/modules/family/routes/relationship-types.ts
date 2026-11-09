import { type FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
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
import { staffId } from './staff.js'


const relationshipTypeRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    '/api/v1/relationship-types',
    {
      schema: {
        operationId: 'listRelationshipTypes',
        response: { 200: relationshipTypeList },
      },
    },
    async () => listRelationshipTypes(app.db, app.cache),
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
    async (request) => createRelationshipType(app.db, app.cache, staffId(request), request.body),
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
    async (request) => patchRelationshipType(app.db, app.cache, staffId(request), request.params.code, request.body),
  )
}

export default relationshipTypeRoutes
