// /people routes (PLAN.md "Family API"). Contracts are final; handlers arrive in later steps.

import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import Type from 'typebox';
import type { FastifyInstance } from 'fastify';
import { PersonParams, ReplaceAddressesBody, ReplacePhonesBody, UpdatePersonBody } from '../schemas/requests.ts';
import { checkAddresses, checkEmail, checkPhones } from '../service/validation.ts';
import { FAMILY_TAG, WRITE_ERRORS, errorResponses, notImplemented } from './common.ts';

const security = [{ bearerAuth: [] }];

export function registerPeopleRoutes(scope: FastifyInstance): void {
  const app = scope.withTypeProvider<TypeBoxTypeProvider>();

  app.patch(
    '/people/:id',
    {
      schema: {
        operationId: 'updatePerson',
        tags: [FAMILY_TAG],
        summary: "Edit a person's names, email, note, occupation or employer",
        security,
        params: PersonParams,
        body: UpdatePersonBody,
        response: { 200: Type.Ref('Person'), ...errorResponses(...WRITE_ERRORS) },
      },
      preHandler: async (request) => checkEmail((request.body as { email?: string }).email),
    },
    notImplemented('updatePerson'),
  );

  app.put(
    '/people/:id/phones',
    {
      schema: {
        operationId: 'replacePersonPhones',
        tags: [FAMILY_TAG],
        summary: "Replace the person's phone list (as typed; phone_normalized is computed)",
        security,
        params: PersonParams,
        body: ReplacePhonesBody,
        response: {
          200: Type.Object({ phones: Type.Array(Type.Ref('PersonPhone')) }),
          ...errorResponses(...WRITE_ERRORS),
        },
      },
      preHandler: async (request) => checkPhones(request.body.phones),
    },
    notImplemented('replacePersonPhones'),
  );

  app.put(
    '/people/:id/addresses',
    {
      schema: {
        operationId: 'replacePersonAddresses',
        tags: [FAMILY_TAG],
        summary: "Replace the person's address list",
        security,
        params: PersonParams,
        body: ReplaceAddressesBody,
        response: {
          200: Type.Object({ addresses: Type.Array(Type.Ref('PersonAddress')) }),
          ...errorResponses(...WRITE_ERRORS),
        },
      },
      preHandler: async (request) => checkAddresses(request.body.addresses),
    },
    notImplemented('replacePersonAddresses'),
  );
}
