// Records how long each Family API write request took (family_api_request_timings), for the p95
// save time of GET /families/admin/pilot-stats (Gate D). Registered on the module's protected
// scope, so it sees every write route, whatever its status.
//
// It runs in onSend, after the handler and the serialisation and before the response is written,
// so the row is in the database by the time the client has its answer (and, in the Family API
// suite, inside the test's transaction). A failed insert is logged and never fails the request.

import type { FastifyInstance } from 'fastify';
import type { FamilyDb } from './db.ts';
import { insertRequestTiming } from './repository/pilot-stats.ts';

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function recordWriteTimings(scope: FastifyInstance, db: FamilyDb): void {
  scope.addHook('onSend', async (request, reply, payload) => {
    if (WRITE_METHODS.has(request.method)) {
      await insertRequestTiming(db.pool, {
        method: request.method,
        route: request.routeOptions.url ?? '(no route)',
        status_code: reply.statusCode,
        duration_ms: Math.round(reply.elapsedTime * 1000) / 1000,
      }).catch((error: unknown) => request.log.warn({ err: error }, 'family: could not record the request timing'));
    }
    return payload;
  });
}
