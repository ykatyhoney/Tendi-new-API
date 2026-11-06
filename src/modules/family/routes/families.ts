import { type FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import type { FastifyRequest } from 'fastify'
import { ApiError } from '../../../lib/api-error.js'
import {
  createFamilyBody,
  createMemberBody,
  familyDetail,
  familyPage,
  familyParams,
  familySearchQuery,
  familyWriteResult,
  memberParams,
  patchFamilyBody,
  patchMemberBody,
} from '../schemas/family.js'
import { getFamily, searchFamilies } from '../services/families.js'
import { createFamily, createMember, deleteMember, patchFamily, patchMember } from '../services/write/families.js'

function staffId(request: FastifyRequest): number {
  if (request.staff === undefined) {
    throw new ApiError(401, 'UNAUTHORIZED', 'A staff bearer token is required')
  }
  return request.staff.adminId
}

const familyRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    '/api/v1/families',
    {
      schema: {
        operationId: 'listFamilies',
        querystring: familySearchQuery,
        response: { 200: familyPage },
      },
    },
    async (request) => searchFamilies(app.db, request.query),
  )

  app.get(
    '/api/v1/families/:id',
    {
      schema: {
        operationId: 'getFamily',
        params: familyParams,
        response: { 200: familyDetail },
      },
    },
    async (request) => {
      const family = await getFamily(app.db, request.params.id)
      if (family === null) {
        throw new ApiError(404, 'NOT_FOUND', 'Family not found')
      }
      return family
    },
  )

  app.post(
    '/api/v1/families',
    {
      schema: {
        operationId: 'createFamily',
        body: createFamilyBody,
        response: { 200: familyWriteResult },
      },
    },
    async (request) => createFamily(app.db, staffId(request), request.body),
  )

  app.patch(
    '/api/v1/families/:id',
    {
      schema: {
        operationId: 'patchFamily',
        params: familyParams,
        body: patchFamilyBody,
        response: { 200: familyWriteResult },
      },
    },
    async (request) => patchFamily(app.db, staffId(request), request.params.id, request.body),
  )

  app.post(
    '/api/v1/families/:id/members',
    {
      schema: {
        operationId: 'createFamilyMember',
        params: familyParams,
        body: createMemberBody,
        response: { 200: familyWriteResult },
      },
    },
    async (request) => createMember(app.db, staffId(request), request.params.id, request.body),
  )

  app.patch(
    '/api/v1/families/:id/members/:memberId',
    {
      schema: {
        operationId: 'patchFamilyMember',
        params: memberParams,
        body: patchMemberBody,
        response: { 200: familyWriteResult },
      },
    },
    async (request) =>
      patchMember(app.db, staffId(request), request.params.id, request.params.memberId, request.body),
  )

  app.delete(
    '/api/v1/families/:id/members/:memberId',
    {
      schema: {
        operationId: 'deleteFamilyMember',
        params: memberParams,
        response: { 200: familyWriteResult },
      },
    },
    async (request) => deleteMember(app.db, staffId(request), request.params.id, request.params.memberId),
  )
}

export default familyRoutes
