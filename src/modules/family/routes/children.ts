// /children routes (PLAN.md "Family API"). Contract is final; the handler arrives in a later step.

import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import Type from 'typebox';
import type { FastifyInstance } from 'fastify';
import { ChildParams } from '../schemas/requests.ts';
import { FAMILY_TAG, WRITE_ERRORS, errorResponses, notImplemented } from './common.ts';

export function registerChildrenRoutes(scope: FastifyInstance): void {
  const app = scope.withTypeProvider<TypeBoxTypeProvider>();

  app.post(
    '/children/:childId/unlink',
    {
      schema: {
        operationId: 'unlinkChild',
        tags: [FAMILY_TAG],
        summary: 'Unlink the child (children.family_id back to NULL; the parent columns keep their values)',
        security: [{ bearerAuth: [] }],
        params: ChildParams,
        response: { 200: Type.Ref('LinkResult'), ...errorResponses(...WRITE_ERRORS) },
      },
    },
    notImplemented('unlinkChild'),
  );
}
