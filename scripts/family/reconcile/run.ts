// Nightly reconciliation (PLAN.md "Rollout", Phase 4 pilot): for every linked child, compares what
// the mirror would write now (sp_family_preview(child_id, NULL)) with the 28 mirrored columns as
// stored, and counts the lock log rows of the last 24 hours. Never fixes data.
// No transaction handling here: the CLI wraps collectDrift in a READ ONLY transaction, the tests
// in their rolled-back one.

import type { Connection, RowDataPacket } from 'mysql2/promise';
import { COLUMNS, compare } from '../proof/compare.ts';
import type { Match, Value } from '../proof/compare.ts';

export interface DriftedChild {
  childId: number;
  familyId: number;
  /** sp_family_preview error, if the values could not be derived at all. */
  error?: string;
  columns: { column: string; stored: Value; derived: Value; match: Match }[];
}

export interface LockLogCount { table: string; column: string; rows: number; children: number }

export interface ReconcileResult {
  linkedChildren: number;
  driftedChildren: number;
  lockLogRows: number;
  drifted: DriftedChild[];
  lockLog: LockLogCount[];
}

/** Details JSON keeps at most this many drifted children; the counts are always complete. */
const MAX_DETAILED_CHILDREN = 200;

const toValue = (v: unknown): Value => (Buffer.isBuffer(v) ? v[0] : (v as Value) ?? null);

export async function collectDrift(db: Connection): Promise<ReconcileResult> {
  const [linked] = await db.query<RowDataPacket[]>(`
    SELECT c.id, c.family_id,
           ${COLUMNS.map((col) => {
             const src = col.table === 'children' ? 'c' : 'cai';
             return col.kind === 'bit' ? `${src}.${col.name} + 0 AS ${col.name}` : `${src}.${col.name}`;
           }).join(', ')}
      FROM children c
      LEFT JOIN children_additional_information cai ON cai.child_id = c.id
     WHERE c.family_id IS NOT NULL
     ORDER BY c.id`);

  const drifted: DriftedChild[] = [];
  for (const row of linked) {
    const child: DriftedChild = { childId: row.id, familyId: row.family_id, columns: [] };
    try {
      const [result] = await db.query<RowDataPacket[][]>('CALL sp_family_preview(?, NULL)', [row.id]);
      const derived = result[0][0];
      for (const col of COLUMNS) {
        const stored = toValue(row[col.name]);
        const value = toValue(derived[col.name]);
        const match = compare(stored, value, col.kind);
        if (match !== 'exact') child.columns.push({ column: col.name, stored, derived: value, match });
      }
    } catch (error) {
      child.error = (error as Error).message;
    }
    if (child.error || child.columns.length > 0) drifted.push(child);
  }

  const [lockRows] = await db.query<RowDataPacket[]>(`
    SELECT table_name, col_name, COUNT(*) AS n, COUNT(DISTINCT child_id) AS children
      FROM family_mirror_lock_log
     WHERE created_at >= NOW() - INTERVAL 24 HOUR
     GROUP BY table_name, col_name
     ORDER BY n DESC, table_name, col_name`);
  const lockLog = lockRows.map((r) => ({ table: r.table_name, column: r.col_name, rows: Number(r.n), children: Number(r.children) }));

  return {
    linkedChildren: linked.length,
    driftedChildren: drifted.length,
    lockLogRows: lockLog.reduce((n, r) => n + r.rows, 0),
    drifted,
    lockLog,
  };
}

/** Writes the summary row; returns its id. */
export async function recordRun(db: Connection, result: ReconcileResult, source: 'scheduled' | 'manual'): Promise<number> {
  const details = {
    columns_compared: COLUMNS.length,
    drifted: result.drifted.slice(0, MAX_DETAILED_CHILDREN),
    drifted_truncated: result.drifted.length > MAX_DETAILED_CHILDREN,
    lock_log_last_24h: result.lockLog,
  };
  const [res] = await db.query(`
    INSERT INTO family_reconcile_runs (run_at, run_date, trigger_source, linked_children, drifted_children, lock_log_rows, details)
    VALUES (NOW(), CURDATE(), ?, ?, ?, ?, ?)`,
  [source, result.linkedChildren, result.driftedChildren, result.lockLogRows, JSON.stringify(details)]);
  return (res as { insertId: number }).insertId;
}
