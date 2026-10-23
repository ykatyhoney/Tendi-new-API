// The Gate D pilot statistics (PLAN.md "Rollout", Phase 4; GET /families/admin/pilot-stats): for
// the last 14 days, the nightly reconciliation runs, where the legacy app still writes mirrored
// columns (lock log), the p95 save time of Family API writes, and the linked children per branch.
// Read-only. Whether Gate D is met is judged by the reader (the Tendi-new pilot page): two of its
// four items are manual.

import type { FamilyDb } from '../db.ts';
import {
  linkedChildrenPerBranch,
  lockLogPerDay,
  reconcileRuns,
  statsWindow,
  writeDurationP95,
} from '../repository/pilot-stats.ts';

/** Gate D: "0 drift for 2 weeks". */
export const PILOT_STATS_DAYS = 14;

export async function getPilotStats(db: FamilyDb, p95TargetMs: number) {
  const window = await statsWindow(db.pool, PILOT_STATS_DAYS);
  const [runs, lockLog, timings, branches] = await Promise.all([
    reconcileRuns(db.pool, window.from, window.to),
    lockLogPerDay(db.pool, window.from, window.to),
    writeDurationP95(db.pool, window.from, window.to),
    linkedChildrenPerBranch(db.pool),
  ]);
  return {
    window: { ...window, days: PILOT_STATS_DAYS },
    reconcile_runs: runs,
    lock_log: lockLog,
    write_timings: { ...timings, target_ms: p95TargetMs },
    linked_children_by_branch: branches,
  };
}
