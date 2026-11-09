import { type FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import type { FastifyRequest } from 'fastify'
import { ApiError } from '../../../lib/api-error.js'
import { childParams } from '../schemas/family.js'
import {
  familyChildParams,
  linkPreview,
  linkResult,
  replaceRightsBody,
  rightsResult,
  unlinkResult,
} from '../schemas/link.js'
import { linkChild, previewLink, replaceRights, unlinkChild } from '../services/links.js'

function staffId(request: FastifyRequest): number {
  if (request.staff === undefined) {
    throw new ApiError(401, 'UNAUTHORIZED', 'A staff bearer token is required')
  }
  return request.staff.adminId
}

const linkRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.put(
    '/api/v1/families/:id/children/:childId/rights',
    {
      schema: {
        operationId: 'replaceChildRights',
        params: familyChildParams,
        body: replaceRightsBody,
        response: { 200: rightsResult },
      },
    },
    async (request) =>
      replaceRights(app.db, staffId(request), request.params.id, request.params.childId, request.body),
  )

  app.get(
    '/api/v1/families/:id/children/:childId/preview',
    {
      schema: {
        operationId: 'previewChildLink',
        params: familyChildParams,
        response: { 200: linkPreview },
      },
    },
    async (request) => previewLink(app.db, request.params.id, request.params.childId),
  )

  app.post(
    '/api/v1/families/:id/children/:childId/link',
    {
      schema: {
        operationId: 'linkChild',
        params: familyChildParams,
        response: { 200: linkResult },
      },
    },
    async (request) => linkChild(app.db, staffId(request), request.params.id, request.params.childId),
  )

  app.post(
    '/api/v1/children/:childId/unlink',
    {
      schema: {
        operationId: 'unlinkChild',
        params: childParams,
        response: { 200: unlinkResult },
      },
    },
    async (request) => unlinkChild(app.db, staffId(request), request.params.childId),
  )
}

export default linkRoutes
