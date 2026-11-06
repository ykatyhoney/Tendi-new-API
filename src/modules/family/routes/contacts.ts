import { type FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import type { FastifyRequest } from 'fastify'
import { ApiError } from '../../../lib/api-error.js'
import {
  contactDetail,
  contactPage,
  contactParams,
  contactSearchQuery,
  contactWriteResult,
  patchContactBody,
  replaceAddressesBody,
  replaceEmailsBody,
  replacePhonesBody,
} from '../schemas/contact.js'
import { getContact, searchContacts } from '../services/contacts.js'
import { patchContact, replaceAddresses, replaceEmails, replacePhones } from '../services/write/contacts.js'

function staffId(request: FastifyRequest): number {
  if (request.staff === undefined) {
    throw new ApiError(401, 'UNAUTHORIZED', 'A staff bearer token is required')
  }
  return request.staff.adminId
}

const contactRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    '/api/v1/contacts',
    {
      schema: {
        operationId: 'listContacts',
        querystring: contactSearchQuery,
        response: { 200: contactPage },
      },
    },
    async (request) => searchContacts(app.db, request.query),
  )

  app.get(
    '/api/v1/contacts/:id',
    {
      schema: {
        operationId: 'getContact',
        params: contactParams,
        response: { 200: contactDetail },
      },
    },
    async (request) => {
      const contact = await getContact(app.db, request.params.id)
      if (contact === null) {
        throw new ApiError(404, 'NOT_FOUND', 'Contact not found')
      }
      return contact
    },
  )

  app.patch(
    '/api/v1/contacts/:id',
    {
      schema: {
        operationId: 'patchContact',
        params: contactParams,
        body: patchContactBody,
        response: { 200: contactWriteResult },
      },
    },
    async (request) => patchContact(app.db, staffId(request), request.params.id, request.body),
  )

  app.put(
    '/api/v1/contacts/:id/phones',
    {
      schema: {
        operationId: 'replaceContactPhones',
        params: contactParams,
        body: replacePhonesBody,
        response: { 200: contactWriteResult },
      },
    },
    async (request) => replacePhones(app.db, staffId(request), request.params.id, request.body),
  )

  app.put(
    '/api/v1/contacts/:id/emails',
    {
      schema: {
        operationId: 'replaceContactEmails',
        params: contactParams,
        body: replaceEmailsBody,
        response: { 200: contactWriteResult },
      },
    },
    async (request) => replaceEmails(app.db, staffId(request), request.params.id, request.body),
  )

  app.put(
    '/api/v1/contacts/:id/addresses',
    {
      schema: {
        operationId: 'replaceContactAddresses',
        params: contactParams,
        body: replaceAddressesBody,
        response: { 200: contactWriteResult },
      },
    },
    async (request) => replaceAddresses(app.db, staffId(request), request.params.id, request.body),
  )
}

export default contactRoutes
