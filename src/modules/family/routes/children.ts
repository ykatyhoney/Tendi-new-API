// /children routes (PLAN.md "Family API"), implemented in step 3.6.

import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import Type from 'typebox';
import type { FastifyInstance } from 'fastify';
import type { FamilyDb } from '../db.ts';
import { ChildParams } from '../schemas/requests.ts';
import { unlinkChild } from '../service/link.ts';
import { FAMILY_TAG, WRITE_ERRORS, errorResponses } from './common.ts';

export function registerChildrenRoutes(scope: FastifyInstance, db: FamilyDb): void {
  const app = scope.withTypeProvider<TypeBoxTypeProvider>();

  app.post(
    '/children/:childId/unlink',
    {
      schema: {
        operationId: 'unlinkChild',
        tags: [FAMILY_TAG],
        summary: 'Unlink the child (children.family_id back to NULL; the parent columns keep their values)',
        description: '404 for an unknown child, 409 when the child is not linked.',
        security: [{ bearerAuth: [] }],
        params: ChildParams,
        response: { 200: Type.Ref('LinkResult'), ...errorResponses(...WRITE_ERRORS) },
      },
    },
    async (request) => unlinkChild(db, request.staff!, request.params.childId),
  );
}
