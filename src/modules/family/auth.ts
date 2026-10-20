// The onRequest hook every Family API route runs behind (registered on the module's protected scope
// in index.ts): authenticates the bearer token, applies the staff-type guard, and sets request.staff
// for audit logging (audit_logs.user_id, @audit_user). It runs before body parsing and schema
// validation, so an unauthenticated request gets 401 whatever its body. CORS preflights (OPTIONS)
// are answered by @fastify/cors on the root instance and never reach it.

import type { FastifyInstance, onRequestAsyncHookHandler } from 'fastify';
import type { FamilyDb } from './db.ts';
import { authenticateStaff, type Staff } from './service/auth.ts';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the family auth hook; null outside the Family API. */
    staff: Staff | null;
  }
}

export function staffAuth(db: FamilyDb, allowedTypes: string[]): onRequestAsyncHookHandler {
  return async (request, reply) => {
    try {
      request.staff = await authenticateStaff(db, request.headers.authorization, allowedTypes);
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode === 401) reply.header('WWW-Authenticate', 'Bearer');
      throw error;
    }
  };
}

/** Adds request.staff and the auth onRequest hook to an encapsulated scope (all routes inside it). */
export function protectScope(scope: FastifyInstance, db: FamilyDb, allowedTypes: string[]): void {
  scope.decorateRequest('staff', null);
  scope.addHook('onRequest', staffAuth(db, allowedTypes));
}
