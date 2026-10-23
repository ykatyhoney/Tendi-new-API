// GET /families/admin/pilot-stats (Gate D) and the request timings it reports: admin only, the
// 14-day window, reconciliation runs, the lock log per day, the p95 of write requests and the
// linked children per branch.
//
// family_api may not write family_reconcile_runs or family_mirror_lock_log, so their fixture rows
// are committed by the test-only root account in before() (marked, so after() removes exactly
// them). Everything the API writes rolls back with its test, as in the other files.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { Connection, RowDataPacket } from 'mysql2/promise';
import { loadFamilyConfig } from '../../src/modules/family/config.ts';
import type { Queryable } from '../../src/modules/family/db.ts';
import { writeDurationP95 } from '../../src/modules/family/repository/pilot-stats.ts';
import { connectTestRoot } from './support/root.ts';
import { freeChildren, readyFamily, useApi } from './support/api.ts';

const api = useApi();
const URL = '/families/admin/pilot-stats';
const FIXTURE = 'pilot-stats-test';
/** A child id no real child has: the lock log has no foreign key. */
const LOCK_CHILD = 2147480001;

let root: Connection;
const runIds: Record<'yesterday' | 'today' | 'old', number> = { yesterday: 0, today: 0, old: 0 };

before(async () => {
  root = await connectTestRoot();
  const run = async (daysAgo: number, source: string, drifted: number) => {
    const [r] = await root.query(
      `INSERT INTO family_reconcile_runs (run_at, run_date, trigger_source, linked_children, drifted_children, lock_log_rows, details)
       VALUES (NOW() - INTERVAL ? DAY, CURDATE() - INTERVAL ? DAY, ?, 3, ?, 0, JSON_OBJECT('fixture', ?))`,
      [daysAgo, daysAgo, source, drifted, FIXTURE],
    );
    return (r as { insertId: number }).insertId;
  };
  runIds.old = await run(20, 'scheduled', 0);
  runIds.yesterday = await run(1, 'scheduled', 0);
  runIds.today = await run(0, 'manual', 1);

  const lock = (col: string, daysAgo: number) =>
    root.query(
      `INSERT INTO family_mirror_lock_log (child_id, table_name, col_name, attempted_value, kept_value, db_user, created_at)
       VALUES (?, 'children', ?, 'x', 'y', ?, NOW() - INTERVAL ? DAY)`,
      [LOCK_CHILD, col, FIXTURE, daysAgo],
    );
  await lock('father_phone', 0);
  await lock('father_phone', 0);
  await lock('mother_phone', 0);
  await lock('father_phone', 20);
});

after(async () => {
  await root?.query("DELETE FROM family_reconcile_runs WHERE JSON_VALUE(details, '$.fixture') = ?", [FIXTURE]);
  await root?.query('DELETE FROM family_mirror_lock_log WHERE db_user = ?', [FIXTURE]);
  await root?.end();
});

/** The stats as the admin staff member sees them. */
async function stats() {
  const res = await api.request('GET', URL, undefined, 'admin');
  assert.equal(res.statusCode, 200, res.body);
  return res.json();
}

async function today(): Promise<string> {
  const [[row]] = await api.db().query<RowDataPacket[]>("SELECT DATE_FORMAT(CURDATE(), '%Y-%m-%d') AS d");
  return row.d;
}

describe('GET /families/admin/pilot-stats: access', () => {
  test('401 without a token', async () => {
    assert.equal((await api.request('GET', URL, undefined, null)).statusCode, 401);
  });

  test('403 for office staff, who may use the rest of the Family API', async () => {
    assert.match(await api.fails('GET', URL, 403), /Only admin staff/);
  });

  test('403 for a teacher', async () => {
    assert.equal((await api.request('GET', URL, undefined, 'teacher')).statusCode, 403);
  });

  test('200 for admin staff, in the documented shape', async () => {
    const body = await stats();
    assert.deepEqual(Object.keys(body).sort(), [
      'linked_children_by_branch',
      'lock_log',
      'reconcile_runs',
      'window',
      'write_timings',
    ]);
  });
});

describe('GET /families/admin/pilot-stats: the 14-day window', () => {
  test('ends today and starts 13 days earlier', async () => {
    const { window } = await stats();
    const [[row]] = await api
      .db()
      .query<RowDataPacket[]>("SELECT DATE_FORMAT(CURDATE() - INTERVAL 13 DAY, '%Y-%m-%d') AS d");
    assert.deepEqual(window, { from: row.d, to: await today(), days: 14 });
  });

  test('lists the reconciliation runs of the window, oldest first, without older ones', async () => {
    const runs = (await stats()).reconcile_runs.filter((r: { id: number }) => Object.values(runIds).includes(r.id));
    assert.deepEqual(
      runs.map((r: { id: number }) => r.id),
      [runIds.yesterday, runIds.today],
    );
    const latest = runs[1];
    assert.equal(latest.run_date, await today());
    assert.match(latest.run_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    assert.deepEqual(
      { source: latest.trigger_source, linked: latest.linked_children, drifted: latest.drifted_children },
      { source: 'manual', linked: 3, drifted: 1 },
    );
    assert.equal('details' in latest, false);
  });

  test('counts the lock log per day, child and column, without its values or older rows', async () => {
    const rows = (await stats()).lock_log.filter((r: { child_id: number }) => r.child_id === LOCK_CHILD);
    const day = await today();
    assert.deepEqual(rows, [
      { day, child_id: LOCK_CHILD, table_name: 'children', col_name: 'father_phone', rows: 2 },
      { day, child_id: LOCK_CHILD, table_name: 'children', col_name: 'mother_phone', rows: 1 },
    ]);
  });
});

describe('GET /families/admin/pilot-stats: write timings', () => {
  async function lastTiming() {
    const [[row]] = await api
      .db()
      .query<RowDataPacket[]>(
        'SELECT method, route, status_code, duration_ms FROM family_api_request_timings ORDER BY id DESC LIMIT 1',
      );
    return row;
  }

  test('every write request is recorded with its route pattern; successful ones count towards p95', async () => {
    const before = (await stats()).write_timings;
    assert.equal(before.target_ms, loadFamilyConfig().pilotP95TargetMs);

    await api.ok('POST', '/families', { name: 'Timed', household_phone: '' }, 201);
    const created = await lastTiming();
    assert.deepEqual(
      { method: created.method, route: created.route, status: created.status_code },
      { method: 'POST', route: '/families', status: 201 },
    );
    assert.ok(Number(created.duration_ms) > 0);

    await api.fails('POST', '/families', 400, {});
    assert.equal((await lastTiming()).status_code, 400);

    const after = (await stats()).write_timings;
    assert.equal(after.requests, before.requests + 1, 'the 400 is recorded but not counted');
    assert.equal(typeof after.p95_ms, 'number');
  });

  test('reads are not recorded', async () => {
    const count = async () => {
      const [[row]] = await api.db().query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM family_api_request_timings');
      return Number(row.n);
    };
    const n = await count();
    await api.ok('GET', '/families?q=Timed');
    await stats();
    assert.equal(await count(), n);
  });

  test('p95 is the nearest-rank 95th percentile of the 2xx durations; null without any', async () => {
    // Rows on a day of their own (far in the future), so earlier requests do not count.
    const db = api.db();
    for (let ms = 1; ms <= 100; ms++) {
      await db.query(
        "INSERT INTO family_api_request_timings (method, route, status_code, duration_ms, created_at) VALUES ('PUT', '/x', 200, ?, '2099-01-01 12:00:00')",
        [ms],
      );
    }
    await db.query(
      "INSERT INTO family_api_request_timings (method, route, status_code, duration_ms, created_at) VALUES ('PUT', '/x', 500, 99999, '2099-01-01 12:00:00')",
    );
    const queryable = db as unknown as Queryable;
    assert.deepEqual(await writeDurationP95(queryable, '2099-01-01', '2099-01-01'), { requests: 100, p95_ms: 95 });
    assert.deepEqual(await writeDurationP95(queryable, '2099-01-02', '2099-01-14'), { requests: 0, p95_ms: null });
  });
});

describe('GET /families/admin/pilot-stats: linked children per branch', () => {
  type Branch = { branch_id: number | null; branch_name: string | null; linked_children: number };
  const countFor = (branches: Branch[], id: number | null) =>
    branches.find((b) => b.branch_id === id)?.linked_children ?? 0;

  test("a linked child counts for its class's branch", async () => {
    const [childId] = await freeChildren(api, 1);
    const [[expected]] = await api.db().query<RowDataPacket[]>(
      `SELECT b.id AS branch_id, b.name AS branch_name FROM children c
         LEFT JOIN classes cl ON cl.id = c.class LEFT JOIN branches b ON b.id = cl.branch WHERE c.id = ?`,
      [childId],
    );
    const before: Branch[] = (await stats()).linked_children_by_branch;

    const { familyId } = await readyFamily(api, 'Branch count', [childId]);
    await api.ok('POST', `/families/${familyId}/children/${childId}/link`);

    const after: Branch[] = (await stats()).linked_children_by_branch;
    assert.equal(countFor(after, expected.branch_id), countFor(before, expected.branch_id) + 1);
    assert.equal(after.find((b) => b.branch_id === expected.branch_id)?.branch_name, expected.branch_name);
    assert.equal(
      after.reduce((n, b) => n + b.linked_children, 0),
      before.reduce((n, b) => n + b.linked_children, 0) + 1,
    );
  });
});
