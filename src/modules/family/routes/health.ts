// GET /health/family: the family module's own check, through its family_api pool.

import Type from 'typebox';
import type { FastifyInstance } from 'fastify';
import type { FamilyDb } from '../db.ts';
import { checkFamilyDb } from '../service/health.ts';

const FamilyHealth = Type.Object(
  {
    status: Type.Union([Type.Literal('ok'), Type.Literal('error')]),
    db: Type.Union([Type.Literal('ok'), Type.Literal('down')]),
  },
  { $id: 'FamilyHealth' },
);

export function registerHealthRoutes(app: FastifyInstance, db: FamilyDb): void {
  app.get(
    '/health/family',
    {
      schema: {
        tags: ['family'],
        summary: 'Family module check: its database pool (family_api account)',
        response: { 200: FamilyHealth, 503: FamilyHealth },
      },
    },
    async (request, reply) => {
      const status = await checkFamilyDb(db, request.log);
      return reply.status(status === 'ok' ? 200 : 503).send({ status: status === 'ok' ? 'ok' : 'error', db: status });
    },
  );
}
