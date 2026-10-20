// Health module: GET /health checks the database pool and, when configured, Redis.
// 200 when everything it uses answers, 503 otherwise.

import Type from 'typebox';
import type { FastifyInstance } from 'fastify';

const Health = Type.Object(
  {
    status: Type.Union([Type.Literal('ok'), Type.Literal('error')]),
    db: Type.Union([Type.Literal('ok'), Type.Literal('down')]),
    redis: Type.Union([Type.Literal('ok'), Type.Literal('down'), Type.Literal('disabled')]),
  },
  { $id: 'Health' },
);

export default async function healthModule(app: FastifyInstance): Promise<void> {
  app.get(
    '/health',
    {
      schema: {
        tags: ['health'],
        summary: 'Liveness check of the API, its database pool and Redis',
        response: { 200: Health, 503: Health },
      },
    },
    async (request, reply) => {
      let db: 'ok' | 'down' = 'ok';
      try {
        await app.db.query('SELECT 1');
      } catch (err) {
        request.log.warn({ err }, 'health: database unreachable');
        db = 'down';
      }

      let redis: 'ok' | 'down' | 'disabled' = 'disabled';
      if (app.redis) {
        try {
          await app.redis.ping();
          redis = 'ok';
        } catch (err) {
          request.log.warn({ err }, 'health: redis unreachable');
          redis = 'down';
        }
      }

      const ok = db === 'ok' && redis !== 'down';
      return reply.status(ok ? 200 : 503).send({ status: ok ? 'ok' : 'error', db, redis });
    },
  );
}
