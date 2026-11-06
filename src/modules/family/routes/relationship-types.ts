import { type FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { relationshipTypeList } from '../schemas/relationship-type.js'
import { listRelationshipTypes } from '../services/relationship-types.js'

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
}

export default relationshipTypeRoutes
