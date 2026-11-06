import { type FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { ApiError } from '../../../lib/api-error.js'
import { childFamily, childParams } from '../schemas/family.js'
import { getChildFamily } from '../services/children.js'

const childRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    '/api/v1/children/:childId/family',
    {
      schema: {
        operationId: 'getChildFamily',
        params: childParams,
        response: { 200: childFamily },
      },
    },
    async (request) => {
      const found = await getChildFamily(app.db, request.params.childId)
      if (found === null) {
        throw new ApiError(404, 'NOT_FOUND', 'This child has no family')
      }
      return found
    },
  )
}

export default childRoutes
