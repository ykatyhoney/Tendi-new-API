// /people routes (PLAN.md "Family API"), implemented in step 3.5. GET /people/:id was added on
// 2026-10-20 for the person editor (it is not in PLAN.md's table).

import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import Type from 'typebox';
import type { FastifyInstance } from 'fastify';
import type { FamilyDb } from '../db.ts';
import { PersonParams, ReplaceAddressesBody, ReplacePhonesBody, UpdatePersonBody } from '../schemas/requests.ts';
import { getPerson, replaceAddresses, replacePhones, updatePerson } from '../service/people.ts';
import { checkAddresses, checkEmail, checkPhones } from '../service/validation.ts';
import { FAMILY_TAG, errorResponses } from './common.ts';

const security = [{ bearerAuth: [] }];

const WRITE_ERRORS = [400, 401, 403, 404];

export function registerPeopleRoutes(scope: FastifyInstance, db: FamilyDb): void {
  const app = scope.withTypeProvider<TypeBoxTypeProvider>();

  app.get(
    '/people/:id',
    {
      schema: {
        operationId: 'getPerson',
        tags: [FAMILY_TAG],
        summary: 'A person with phones, addresses and every household they belong to',
        description: '404 for an unknown or trashed person.',
        security,
        params: PersonParams,
        response: { 200: Type.Ref('PersonDetail'), ...errorResponses(400, 401, 403, 404) },
      },
    },
    async (request) => getPerson(db, request.params.id),
  );

  app.patch(
    '/people/:id',
    {
      schema: {
        operationId: 'updatePerson',
        tags: [FAMILY_TAG],
        summary: "Edit a person's names, email, note, occupation or employer",
        description:
          'legacy_full_name cannot be set directly: a change of fname or lname, or reset_legacy_full_name: true, sets it to "fname lname" (at most 100 characters). 404 for an unknown or trashed person.',
        security,
        params: PersonParams,
        body: UpdatePersonBody,
        response: { 200: Type.Ref('PersonResult'), ...errorResponses(...WRITE_ERRORS) },
      },
      preHandler: async (request) => checkEmail(request.body.email),
    },
    async (request) => updatePerson(db, request.staff!, request.params.id, request.body),
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
        response: { 200: Type.Ref('PhonesResult'), ...errorResponses(...WRITE_ERRORS) },
      },
      preHandler: async (request) => checkPhones(request.body.phones),
    },
    async (request) => replacePhones(db, request.staff!, request.params.id, request.body.phones),
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
        response: { 200: Type.Ref('AddressesResult'), ...errorResponses(...WRITE_ERRORS) },
      },
      preHandler: async (request) => checkAddresses(request.body.addresses),
    },
    async (request) => replaceAddresses(db, request.staff!, request.params.id, request.body.addresses),
  );
}
