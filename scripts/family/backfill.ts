// Family backfill (PLAN.md "Data backfill and proof of equivalence", step 2.1): builds DRAFT
// families from the legacy parent columns. Writes only the 6 family tables plus its own
// bookkeeping (family_backfill_runs / _rows / _child_map); never sets children.family_id.
//
// Usage: npm run family:backfill -- [options]
//   --dry-run               read and plan only; print counts, write nothing
//   --reset                 delete the rows earlier runs created (and nothing else), then rebuild
//   --group-by-home-phone   also group siblings on children_additional_information.*_home_phone (not in D3)
//   --database <name>       target database (default DB_NAME); must be a local tendi_family_* database
//   --review-dir <path>     where the review CSV goes (default var/family-backfill, git-ignored)
//
// One run is one transaction: it either completes or leaves nothing behind.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { Connection, RowDataPacket } from 'mysql2/promise';
import { API_ROOT, connectLocal, loadEnv, requireEnv } from './lib/db.ts';
import { REVIEW_CODES, planBackfill } from './backfill/plan.ts';
import type { LegacyChild, Plan, ReviewCode } from './backfill/plan.ts';

/** Delete order for --reset: children of a foreign key before its parent. */
const CREATED_TABLES = ['family_member_children', 'family_members', 'people_phones', 'people_addresses', 'people', 'families'] as const;
type CreatedTable = (typeof CREATED_TABLES)[number];

const CAI_FIELDS = ['fname', 'lname', 'home_phone', 'email', 'address', 'occupation', 'employer', 'work_address', 'office_phone'];
const CAI_COLUMNS = ['father', 'mother'].flatMap((slot) => CAI_FIELDS.map((f) => `${slot}_${f}`));

const { values: args } = parseArgs({
  options: {
    'dry-run': { type: 'boolean', default: false },
    reset: { type: 'boolean', default: false },
    'group-by-home-phone': { type: 'boolean', default: false },
    database: { type: 'string' },
    'review-dir': { type: 'string' },
  },
});

async function readChildren(db: Connection): Promise<{ children: LegacyChild[]; skippedLinked: number }> {
  const [found] = await db.query<RowDataPacket[]>(`
    SELECT c.id, c.family_id, c.lname, c.father_name, c.mother_name, c.father_phone, c.mother_phone, c.home_phone,
           c.parent_email,
           c.use_father_phone_for_notification + 0 AS use_father_phone_for_notification,
           c.use_mother_phone_for_notification + 0 AS use_mother_phone_for_notification,
           c.notification_father_phone_method, c.notification_mother_phone_method,
           cai.id AS cai_id, ${CAI_COLUMNS.map((col) => `cai.${col}`).join(', ')}
      FROM children c
      LEFT JOIN children_additional_information cai ON cai.child_id = c.id
     WHERE c.status <> 'trash'
     ORDER BY c.id`);
  const children: LegacyChild[] = [];
  let skippedLinked = 0;
  for (const r of found) {
    if (r.family_id !== null) { skippedLinked++; continue; }
    children.push({
      id: r.id, lname: r.lname, father_name: r.father_name, mother_name: r.mother_name,
      father_phone: r.father_phone, mother_phone: r.mother_phone, home_phone: r.home_phone, parent_email: r.parent_email,
      use_father_phone_for_notification: r.use_father_phone_for_notification,
      use_mother_phone_for_notification: r.use_mother_phone_for_notification,
      notification_father_phone_method: r.notification_father_phone_method,
      notification_mother_phone_method: r.notification_mother_phone_method,
      has_cai: r.cai_id !== null,
      cai: Object.fromEntries(CAI_COLUMNS.map((col) => [col, r[col] ?? ''])),
    });
  }
  return { children, skippedLinked };
}

interface PreviousRun { id: number; rows: Record<string, number> }

async function previousRuns(db: Connection): Promise<PreviousRun[]> {
  const [runs] = await db.query<RowDataPacket[]>("SELECT id FROM family_backfill_runs WHERE status = 'done' ORDER BY id");
  const out: PreviousRun[] = [];
  for (const run of runs) {
    const [counts] = await db.query<RowDataPacket[]>(
      'SELECT table_name, COUNT(*) AS n FROM family_backfill_rows WHERE run_id = ? GROUP BY table_name', [run.id]);
    out.push({ id: run.id, rows: Object.fromEntries(counts.map((c) => [c.table_name, Number(c.n)])) });
  }
  return out;
}

/** Deletes exactly the rows a run created. Refuses if any child is linked to one of its families. */
async function resetRun(db: Connection, runId: number): Promise<void> {
  const [[linked]] = await db.query<RowDataPacket[]>(`
    SELECT COUNT(*) AS n FROM children c
      JOIN family_backfill_rows r ON r.run_id = ? AND r.table_name = 'families' AND r.row_id = c.family_id`, [runId]);
  if (Number(linked.n) > 0) {
    throw new Error(`run ${runId}: ${linked.n} children are linked to its draft families; unlink them before --reset`);
  }
  for (const table of CREATED_TABLES) {
    await db.query(`DELETE t FROM \`${table}\` t
                      JOIN family_backfill_rows r ON r.run_id = ? AND r.table_name = ? AND r.row_id = t.id`, [runId, table]);
  }
  await db.query('DELETE FROM family_backfill_child_map WHERE run_id = ?', [runId]);
  await db.query('DELETE FROM family_backfill_rows WHERE run_id = ?', [runId]);
  await db.query("UPDATE family_backfill_runs SET status = 'reset', reset_at = NOW() WHERE id = ?", [runId]);
}

async function insert(db: Connection, sql: string, params: unknown[]): Promise<number> {
  const [result] = await db.query(sql, params);
  return (result as { insertId: number }).insertId;
}

async function bulkInsert(db: Connection, sql: string, rows: unknown[][]): Promise<void> {
  for (let i = 0; i < rows.length; i += 500) await db.query(sql, [rows.slice(i, i + 500)]);
}

/** Writes the plan; returns household ref -> families.id. */
async function writePlan(db: Connection, plan: Plan, runId: number): Promise<Map<number, number>> {
  const created: [number, CreatedTable, number][] = [];
  const track = (table: CreatedTable, id: number) => { created.push([runId, table, id]); return id; };
  const familyIds = new Map<number, number>();
  const childMap: [number, number, number][] = [];

  for (const h of plan.households) {
    const familyId = track('families', await insert(db, `
      INSERT INTO families (name, household_phone, status, created_at, updated_at, created_by, updated_by)
      VALUES (?, ?, 'active', NOW(), NOW(), 0, 0)`, [h.name, h.householdPhone]));
    familyIds.set(h.ref, familyId);

    const memberIds = new Map<object, number>();
    for (const p of h.people) {
      const personId = track('people', await insert(db, `
        INSERT INTO people (fname, lname, legacy_full_name, hebrew_name, email, occupation, employer, status,
                            created_at, updated_at, created_by, updated_by)
        VALUES (?, ?, ?, '', ?, ?, ?, 'active', NOW(), NOW(), 0, 0)`,
      [p.fname, p.lname, p.legacyFullName, p.email, p.occupation, p.employer]));
      for (const ph of p.phones) {
        track('people_phones', await insert(db, `
          INSERT INTO people_phones (person_id, phone, phone_normalized, label, is_primary, sort_order)
          VALUES (?, ?, ?, ?, ?, ?)`, [personId, ph.phone, ph.normalized, ph.label, ph.isPrimary, ph.sortOrder]));
      }
      for (const a of p.addresses) {
        track('people_addresses', await insert(db,
          'INSERT INTO people_addresses (person_id, kind, line1) VALUES (?, ?, ?)', [personId, a.kind, a.line1]));
      }
      memberIds.set(p, track('family_members', await insert(db, `
        INSERT INTO family_members (family_id, person_id, relationship, is_primary, sort_order)
        VALUES (?, ?, ?, ?, ?)`, [familyId, personId, p.slot, p.isPrimary, p.sortOrder])));
    }
    for (const r of h.rights) {
      track('family_member_children', await insert(db, `
        INSERT INTO family_member_children (member_id, child_id, receives_notifications, notify_method, is_payment_responsible)
        VALUES (?, ?, ?, ?, ?)`, [memberIds.get(r.person), r.childId, r.receivesNotifications, r.notifyMethod, r.isPaymentResponsible]));
    }
    for (const childId of h.childIds) childMap.push([runId, childId, familyId]);
  }

  await bulkInsert(db, 'INSERT INTO family_backfill_rows (run_id, table_name, row_id) VALUES ?', created);
  await bulkInsert(db, 'INSERT INTO family_backfill_child_map (run_id, child_id, family_id) VALUES ?', childMap);
  return familyIds;
}

function counts(plan: Plan) {
  const people = plan.households.flatMap((h) => h.people);
  const sizes = new Map<number, number>();
  for (const h of plan.households) sizes.set(h.childIds.length, (sizes.get(h.childIds.length) ?? 0) + 1);
  const review = new Map<string, number>();
  for (const item of plan.review) review.set(item.code, (review.get(item.code) ?? 0) + 1);
  return {
    created: {
      families: plan.households.length,
      people: people.length,
      family_members: people.length,
      people_phones: people.reduce((n, p) => n + p.phones.length, 0),
      people_addresses: people.reduce((n, p) => n + p.addresses.length, 0),
      family_member_children: plan.households.reduce((n, h) => n + h.rights.length, 0),
      children_mapped: plan.households.reduce((n, h) => n + h.childIds.length, 0),
    },
    householdSizes: Object.fromEntries([...sizes].sort(([a], [b]) => a - b).map(([size, n]) => [`${size} child${size > 1 ? 'ren' : ''}`, n])),
    review: Object.fromEntries((Object.keys(REVIEW_CODES) as ReviewCode[]).map((code) => [code, review.get(code) ?? 0])),
  };
}

const csvCell = (v: string | number) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

function reviewCsv(plan: Plan, familyIds: Map<number, number> | null): string {
  const lines = ['reason_code,family_ids,child_ids,phone_normalized,detail,reason'];
  for (const item of plan.review) {
    const families = item.householdRefs.map((ref) => (familyIds ? familyIds.get(ref) : `draft#${ref}`)).join(' ');
    lines.push([item.code, families, item.childIds.join(' '), item.phone, item.detail, REVIEW_CODES[item.code]].map(csvCell).join(','));
  }
  return `${lines.join('\n')}\n`;
}

function printSummary(title: string, summary: ReturnType<typeof counts>, extra: Record<string, number>) {
  console.log(`\n${title}`);
  for (const [label, n] of Object.entries({ ...extra, ...summary.created })) console.log(`  ${label.padEnd(26)} ${String(n).padStart(6)}`);
  console.log('\nHouseholds by size');
  for (const [label, n] of Object.entries(summary.householdSizes)) console.log(`  ${label.padEnd(26)} ${String(n).padStart(6)}`);
  console.log('\nReview items by reason code');
  for (const [code, n] of Object.entries(summary.review)) console.log(`  ${code.padEnd(34)} ${String(n).padStart(6)}`);
}

async function main() {
  loadEnv();
  const database = args.database ?? requireEnv('DB_NAME');
  const options = args['group-by-home-phone'] ? 'group-by-home-phone' : '';
  const db = await connectLocal(database);
  try {
    const started = performance.now();
    const previous = await previousRuns(db);
    if (previous.length > 0 && !args.reset) {
      throw new Error(`draft families from run(s) ${previous.map((r) => r.id).join(', ')} exist; use --reset to rebuild`);
    }
    const { children, skippedLinked } = await readChildren(db);
    const plan = planBackfill(children, { groupByHomePhone: args['group-by-home-phone'] });
    const summary = counts(plan);
    const toDelete = previous.reduce((n, r) => n + Object.values(r.rows).reduce((a, b) => a + b, 0), 0);
    const header = { children_read: children.length + skippedLinked, children_skipped_linked: skippedLinked };

    console.log(`Database ${database}${options ? `, options: ${options}` : ''}`);
    if (args['dry-run']) {
      if (args.reset) console.log(`--reset would delete ${toDelete} rows created by run(s) ${previous.map((r) => r.id).join(', ') || '(none)'}`);
      printSummary('DRY RUN: would create', summary, header);
      return;
    }

    await db.beginTransaction();
    try {
      for (const run of previous) await resetRun(db, run.id);
      if (previous.length > 0) console.log(`Reset: deleted ${toDelete} rows created by run(s) ${previous.map((r) => r.id).join(', ')}`);
      const runId = await insert(db, 'INSERT INTO family_backfill_runs (options, started_at) VALUES (?, NOW())', [options]);
      const familyIds = await writePlan(db, plan, runId);
      await db.query('UPDATE family_backfill_runs SET summary = ?, finished_at = NOW() WHERE id = ?',
        [JSON.stringify({ ...header, ...summary }), runId]);
      await db.commit();

      const dir = resolve(args['review-dir'] ?? join(API_ROOT, 'var', 'family-backfill'));
      mkdirSync(dir, { recursive: true });
      const csv = join(dir, `review-run-${runId}.csv`);
      writeFileSync(csv, reviewCsv(plan, familyIds));

      printSummary(`Run ${runId}: created (${((performance.now() - started) / 1000).toFixed(1)} s)`, summary, header);
      console.log(`\nReview CSV: ${relative(process.cwd(), csv)} (${plan.review.length} items; contains personal data, keep it out of git)`);
    } catch (error) {
      await db.rollback();
      throw error;
    }
  } finally {
    await db.end();
  }
}

main().catch((error: Error) => {
  console.error(`error: ${error.message}`);
  process.exitCode = 1;
});
