// /families routes (PLAN.md "Family API"). Search, detail, create and edit (step 3.4) and the member
// routes (step 3.5) are implemented; the others answer 501 until their step.

import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import Type from 'typebox';
import type { FastifyInstance } from 'fastify';
import {
  AddMemberBody,
  CreateFamilyBody,
  FamilyChildParams,
  FamilyMemberParams,
  FamilyParams,
  SearchFamiliesQuery,
  SetChildRightsBody,
  UpdateFamilyBody,
  UpdateMemberBody,
} from '../schemas/requests.ts';
import type { FamilyDb } from '../db.ts';
import { createFamily, getFamily, searchFamilies, updateFamily } from '../service/families.ts';
import { addMember, removeMember, updateMember } from '../service/members.ts';
import { checkAddMember, checkHouseholdPhone, checkRights } from '../service/validation.ts';
import { FAMILY_TAG, READ_ERRORS, WRITE_ERRORS, errorResponses, notImplemented } from './common.ts';

const security = [{ bearerAuth: [] }];

export function registerFamilyRoutes(scope: FastifyInstance, db: FamilyDb): void {
  const app = scope.withTypeProvider<TypeBoxTypeProvider>();

  app.get(
    '/families',
    {
      schema: {
        operationId: 'searchFamilies',
        tags: [FAMILY_TAG],
        summary: 'Search families by family name, person name or phone (phone_normalized)',
        security,
        querystring: SearchFamiliesQuery,
        response: { 200: Type.Ref('FamilySearchResult'), ...errorResponses(400, 401, 403) },
      },
    },
    async (request) => searchFamilies(db, request.query),
  );

  app.post(
    '/families',
    {
      schema: {
        operationId: 'createFamily',
        tags: [FAMILY_TAG],
        summary: 'Create a household',
        security,
        body: CreateFamilyBody,
        response: { 201: Type.Ref('Family'), ...errorResponses(400, 401, 403) },
      },
      preHandler: async (request) => checkHouseholdPhone(request.body.household_phone),
    },
    async (request, reply) => reply.status(201).send(await createFamily(db, request.staff!, request.body)),
  );

  app.get(
    '/families/:id',
    {
      schema: {
        operationId: 'getFamily',
        tags: [FAMILY_TAG],
        summary: 'Household with members, phones, addresses, children (linked or with rights rows) and their rights',
        security,
        params: FamilyParams,
        response: { 200: Type.Ref('Family'), ...errorResponses(400, 401, 403, 404) },
      },
    },
    async (request) => getFamily(db, request.params.id),
  );

  app.patch(
    '/families/:id',
    {
      schema: {
        operationId: 'updateFamily',
        tags: [FAMILY_TAG],
        summary: 'Edit the household name or household phone',
        security,
        params: FamilyParams,
        body: UpdateFamilyBody,
        response: { 200: Type.Ref('Family'), ...errorResponses(400, 401, 403, 404) },
      },
      preHandler: async (request) => checkHouseholdPhone(request.body.household_phone),
    },
    async (request) => updateFamily(db, request.staff!, request.params.id, request.body),
  );

  app.post(
    '/families/:id/members',
    {
      schema: {
        operationId: 'addFamilyMember',
        tags: [FAMILY_TAG],
        summary: 'Add a person (existing: person_id; new: person) with a relationship',
        description:
          'A person is in a family at most once (uniq_fm): 409 when already an active member. A person removed earlier (status trash) is brought back with the new values (200). 404 for an unknown or trashed family or person_id.',
        security,
        params: FamilyParams,
        body: AddMemberBody,
        response: {
          201: Type.Ref('FamilyMemberResult', { description: 'Added' }),
          200: Type.Ref('FamilyMemberResult', { description: 'A removed member brought back' }),
          ...errorResponses(400, 401, 403, 404, 409),
        },
      },
      preHandler: async (request) => checkAddMember(request.body),
    },
    async (request, reply) => {
      const { status, body } = await addMember(db, request.staff!, request.params.id, request.body);
      return reply.status(status).send(body);
    },
  );

  app.patch(
    '/families/:id/members/:memberId',
    {
      schema: {
        operationId: 'updateFamilyMember',
        tags: [FAMILY_TAG],
        summary: 'Change the relationship, primary flag or display order of a member',
        security,
        description: 'Making a member primary clears is_primary on the family’s other members.',
        params: FamilyMemberParams,
        body: UpdateMemberBody,
        response: { 200: Type.Ref('FamilyMemberResult'), ...errorResponses(400, 401, 403, 404) },
      },
    },
    async (request) => updateMember(db, request.staff!, request.params.id, request.params.memberId, request.body),
  );

  app.delete(
    '/families/:id/members/:memberId',
    {
      schema: {
        operationId: 'removeFamilyMember',
        tags: [FAMILY_TAG],
        summary: 'Remove a member (sets status trash; the row and its rights rows are kept)',
        security,
        params: FamilyMemberParams,
        response: {
          200: Type.Ref('FamilyMemberResult', { description: 'The member, now status trash' }),
          ...errorResponses(400, 401, 403, 404),
        },
      },
    },
    async (request) => removeMember(db, request.staff!, request.params.id, request.params.memberId),
  );

  app.put(
    '/families/:id/children/:childId/rights',
    {
      schema: {
        operationId: 'setChildRights',
        tags: [FAMILY_TAG],
        summary: "Set every member's rights for one child (notifications, collection, emergency, payment)",
        security,
        params: FamilyChildParams,
        body: SetChildRightsBody,
        response: {
          200: Type.Object({ rights: Type.Array(Type.Ref('ChildRight')) }),
          ...errorResponses(...WRITE_ERRORS),
        },
      },
      preHandler: async (request) => checkRights(request.body.rights),
    },
    notImplemented('setChildRights'),
  );

  app.get(
    '/families/:id/children/:childId/preview',
    {
      schema: {
        operationId: 'previewChildLink',
        tags: [FAMILY_TAG],
        summary: 'The 28 mirrored legacy values now and after linking the child to this family',
        security,
        params: FamilyChildParams,
        response: { 200: Type.Ref('LinkPreview'), ...errorResponses(...READ_ERRORS) },
      },
    },
    notImplemented('previewChildLink'),
  );

  app.post(
    '/families/:id/children/:childId/link',
    {
      schema: {
        operationId: 'linkChild',
        tags: [FAMILY_TAG],
        summary: 'Link the child (sets children.family_id; the mirror then owns its parent columns)',
        security,
        params: FamilyChildParams,
        response: { 200: Type.Ref('LinkResult'), ...errorResponses(...WRITE_ERRORS) },
      },
    },
    notImplemented('linkChild'),
  );
}
