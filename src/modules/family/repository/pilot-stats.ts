// SQL for the Gate D pilot statistics (GET /families/admin/pilot-stats) and for recording the
// request timings it reports. Reads only the columns scripts/family/grants.sql grants: no values
// from the lock log or the reconciliation details. No business rules here.

import type { RowDataPacket } from 'mysql2/promise';
import type { Queryable } from '../db.ts';

export interface RequestTiming {
  method: string;
  route: string;
  status_code: number;
  duration_ms: number;
}

export async function insertRequestTiming(db: Queryable, t: RequestTiming): Promise<void> {
  await db.query(
    'INSERT INTO family_api_request_timings (method, route, status_code, duration_ms) VALUES (?, ?, ?, ?)',
    [t.method, t.route, t.status_code, t.duration_ms],
  );
}

/** The last `days` calendar days by the database server's clock, today included (YYYY-MM-DD). */
export async function statsWindow(db: Queryable, days: number): Promise<{ from: string; to: string }> {
  const [[row]] = await db.query<RowDataPacket[]>(
    "SELECT DATE_FORMAT(CURDATE() - INTERVAL ? DAY, '%Y-%m-%d') AS `from`, DATE_FORMAT(CURDATE(), '%Y-%m-%d') AS `to`",
    [days - 1],
  );
  return { from: row.from, to: row.to };
}

export interface ReconcileRunRow {
  id: number;
  run_at: string;
  run_date: string;
  trigger_source: 'scheduled' | 'manual';
  linked_children: number;
  drifted_children: number;
}

/** Reconciliation runs whose run_date is in [from, to], oldest first. */
export async function reconcileRuns(db: Queryable, from: string, to: string): Promise<ReconcileRunRow[]> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT id, run_at, run_date, trigger_source, linked_children, drifted_children
       FROM family_reconcile_runs WHERE run_date BETWEEN ? AND ? ORDER BY run_at, id`,
    [from, to],
  );
  return rows as ReconcileRunRow[];
}

export interface LockLogDayRow {
  day: string;
  child_id: number;
  table_name: string;
  col_name: string;
  rows: number;
}

/** family_mirror_lock_log rows on the days [from, to], counted per day, child and column. */
export async function lockLogPerDay(db: Queryable, from: string, to: string): Promise<LockLogDayRow[]> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT DATE_FORMAT(created_at, '%Y-%m-%d') AS day, child_id, table_name, col_name, COUNT(*) AS \`rows\`
       FROM family_mirror_lock_log
      WHERE created_at >= ? AND created_at < DATE(?) + INTERVAL 1 DAY
      GROUP BY day, child_id, table_name, col_name
      ORDER BY day, child_id, table_name, col_name`,
    [from, to],
  );
  return rows.map((r) => ({ ...(r as LockLogDayRow), rows: Number(r.rows) }));
}

/**
 * The 95th percentile (nearest rank) of the durations of successful (2xx) write requests on the
 * days [from, to], and how many there were. p95_ms is null without any.
 */
export async function writeDurationP95(
  db: Queryable,
  from: string,
  to: string,
): Promise<{ requests: number; p95_ms: number | null }> {
  const where = 'created_at >= ? AND created_at < DATE(?) + INTERVAL 1 DAY AND status_code BETWEEN 200 AND 299';
  const [[count]] = await db.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS n FROM family_api_request_timings WHERE ${where}`,
    [from, to],
  );
  const requests = Number(count.n);
  if (requests === 0) return { requests, p95_ms: null };
  const [[row]] = await db.query<RowDataPacket[]>(
    `SELECT duration_ms FROM family_api_request_timings WHERE ${where} ORDER BY duration_ms LIMIT 1 OFFSET ?`,
    [from, to, Math.ceil(0.95 * requests) - 1],
  );
  return { requests, p95_ms: Number(row.duration_ms) };
}

export interface BranchCountRow {
  branch_id: number | null;
  branch_name: string | null;
  linked_children: number;
}

/** Linked children (children.family_id set) per branch of their class; no class or branch is null. */
export async function linkedChildrenPerBranch(db: Queryable): Promise<BranchCountRow[]> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT b.id AS branch_id, b.name AS branch_name, COUNT(*) AS linked_children
       FROM children c
       LEFT JOIN classes cl ON cl.id = c.class
       LEFT JOIN branches b ON b.id = cl.branch
      WHERE c.family_id IS NOT NULL
      GROUP BY b.id, b.name
      ORDER BY b.name IS NULL, b.name, b.id`,
  );
  return rows.map((r) => ({ ...(r as BranchCountRow), linked_children: Number(r.linked_children) }));
}
