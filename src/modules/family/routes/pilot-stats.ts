// GET /families/admin/pilot-stats: the Gate D figures for the pilot (PLAN.md "Rollout", Phase 4),
// added 2026-10-21 for Tendi-new's /families/pilot page (not in PLAN.md's table). Admin staff only:
// the scope's auth hook runs first (401, 403 for types outside FAMILY_ALLOWED_STAFF_TYPES), then
// requireStaffTypes('admin') answers 403 to the other allowed types (office).

import Type from 'typebox';
import type { FastifyInstance } from 'fastify';
import { requireStaffTypes } from '../auth.ts';
import type { FamilyDb } from '../db.ts';
import { getPilotStats, PILOT_STATS_DAYS } from '../service/pilot-stats.ts';
import { FAMILY_TAG, errorResponses } from './common.ts';

export function registerPilotStatsRoutes(app: FastifyInstance, db: FamilyDb, p95TargetMs: number): void {
  app.get(
    '/families/admin/pilot-stats',
    {
      preHandler: requireStaffTypes('admin'),
      schema: {
        operationId: 'getPilotStats',
        tags: [FAMILY_TAG],
        summary: `Gate D pilot statistics for the last ${PILOT_STATS_DAYS} days (admin staff only)`,
        description:
          'Reconciliation runs (linked and drifted children), the lock log per day, child and column (where the legacy app still writes parent data), the p95 duration of successful Family API writes with its target, and the linked children per branch. Read-only; 403 for any staff type other than admin.',
        security: [{ bearerAuth: [] }],
        response: { 200: Type.Ref('PilotStats'), ...errorResponses(401, 403) },
      },
    },
    async () => getPilotStats(db, p95TargetMs),
  );
}
