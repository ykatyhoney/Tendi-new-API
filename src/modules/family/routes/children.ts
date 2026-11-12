import { type FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { ApiError } from '../../../lib/api-error.js'
import { childListItem, childListQuery, childPage } from '../schemas/child.js'
import { childFamily, childParams } from '../schemas/family.js'
import { getChild, getChildFamily, searchChildren } from '../services/children.js'

const childRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    '/api/v1/children',
    {
      schema: {
        operationId: 'listChildren',
        querystring: childListQuery,
        response: { 200: childPage },
      },
    },
    async (request) => searchChildren(app.db, request.query),
  )

  app.get(
    '/api/v1/children/:childId',
    {
      schema: {
        operationId: 'getChild',
        params: childParams,
        response: { 200: childListItem },
      },
    },
    async (request) => {
      const child = await getChild(app.db, request.params.childId)
      if (child === null) {
        throw new ApiError(404, 'NOT_FOUND', 'Child not found')
      }
      return child
    },
  )

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
