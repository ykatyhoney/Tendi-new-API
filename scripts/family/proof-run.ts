// Family proof run (PLAN.md "Data backfill and proof of equivalence", step 2.2).
// For every child mapped to a draft family by a backfill run, derives the 28 mirrored legacy
// values with sp_family_preview(child, draft family) and compares them with what children and
// children_additional_information hold today. Target: filled exactly as today; the only accepted
// differences are ALLOWED_CAUSES, anything else is a failure (exit code 1).
// Read-only: everything runs in a READ ONLY transaction, and table checksums are compared
// before and after.
//
// Usage: npm run family:proof-run -- [--run <id>] [--database <name>] [--out <md>] [--csv-dir <dir>]
//   --run      backfill run to check (default: the latest 'done' run)
//   --out      summary report, ids and counts only (default docs/family/family-sync-proof.md)
//   --csv-dir  full diff with names and values (default var/family-proof, git-ignored)

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { Connection, RowDataPacket } from 'mysql2/promise';
import { API_ROOT, connectLocal, loadEnv, requireEnv } from './lib/db.ts';
import { ALLOWED_CAUSES, CAUSES, COLUMNS, classify, compare } from './proof/compare.ts';
import type { Cause, ChildContext, Match, Value } from './proof/compare.ts';

const { values: args } = parseArgs({
  options: {
    run: { type: 'string' },
    database: { type: 'string' },
    out: { type: 'string' },
    'csv-dir': { type: 'string' },
  },
});

const CHECKED_TABLES = ['children', 'children_additional_information', 'families', 'people', 'family_members',
  'people_phones', 'people_addresses', 'family_member_children', 'family_mirror_lock_log', 'record_audit'];
const BIT_COLUMNS = COLUMNS.filter((c) => c.kind === 'bit').map((c) => c.name);

interface Diff {
  childId: number; childName: string; familyId: number; householdSize: number;
  column: string; stored: Value; derived: Value; match: Match; cause: Cause;
}

const toValue = (v: unknown): Value => (Buffer.isBuffer(v) ? v[0] : (v as Value) ?? null);

async function checksums(db: Connection): Promise<string> {
  const [rows] = await db.query<RowDataPacket[]>(`CHECKSUM TABLE ${CHECKED_TABLES.join(', ')}`);
  return rows.map((r) => `${r.Table}=${r.Checksum}`).join(';');
}

async function main() {
  loadEnv();
  const database = args.database ?? requireEnv('DB_NAME');
  const db = await connectLocal(database);
  try {
    const before = await checksums(db);
    await db.query('SET SESSION TRANSACTION READ ONLY');
    await db.beginTransaction();

    const [[run]] = await db.query<RowDataPacket[]>(
      args.run ? 'SELECT * FROM family_backfill_runs WHERE id = ?' : "SELECT * FROM family_backfill_runs WHERE status = 'done' ORDER BY id DESC LIMIT 1",
      args.run ? [Number(args.run)] : []);
    if (!run) throw new Error('no backfill run to check; run npm run family:backfill first');
    if (run.status !== 'done') throw new Error(`run ${run.id} has status '${run.status}'; its families were deleted`);

    const [map] = await db.query<RowDataPacket[]>(
      'SELECT child_id, family_id FROM family_backfill_child_map WHERE run_id = ? ORDER BY child_id', [run.id]);
    const sizes = new Map<number, number>();
    for (const m of map) sizes.set(m.family_id, (sizes.get(m.family_id) ?? 0) + 1);

    const [stored] = await db.query<RowDataPacket[]>(`
      SELECT c.id, c.fname, c.lname, cai.id IS NOT NULL AS has_cai, c.home_send_notification + 0 AS home_send_notification,
             ${COLUMNS.map((col) => {
               const src = col.table === 'children' ? 'c' : 'cai';
               return BIT_COLUMNS.includes(col.name) ? `${src}.${col.name} + 0 AS ${col.name}` : `${src}.${col.name}`;
             }).join(', ')}
        FROM family_backfill_child_map m
        JOIN children c ON c.id = m.child_id
        LEFT JOIN children_additional_information cai ON cai.child_id = c.id
       WHERE m.run_id = ?`, [run.id]);
    const storedById = new Map(stored.map((r) => [r.id as number, r]));

    const [members] = await db.query<RowDataPacket[]>(`
      SELECT fm.id, fm.family_id, fm.relationship, fm.sort_order, fm.status = 'active' AND p.status = 'active' AS active
        FROM family_members fm JOIN people p ON p.id = fm.person_id
       WHERE fm.family_id IN (SELECT family_id FROM family_backfill_child_map WHERE run_id = ?)`, [run.id]);
    const [rights] = await db.query<RowDataPacket[]>(`
      SELECT fmc.member_id, fmc.child_id, fmc.is_payment_responsible
        FROM family_member_children fmc
        JOIN family_backfill_child_map m ON m.run_id = ? AND m.child_id = fmc.child_id`, [run.id]);
    const [families] = await db.query<RowDataPacket[]>(`
      SELECT f.id, f.household_phone FROM families f
       WHERE f.id IN (SELECT family_id FROM family_backfill_child_map WHERE run_id = ?)`, [run.id]);
    const householdPhone = new Map(families.map((f) => [f.id as number, f.household_phone as string]));
    const memberById = new Map(members.map((m) => [m.id as number, m]));

    /** The member the mirror picks for a slot (same rule as sp_family_mirror_values). */
    const chosenMember = (familyId: number, slot: 'father' | 'mother') => {
      const candidates = members
        .filter((m) => m.family_id === familyId && m.active && (m.relationship === slot || m.relationship === `step_${slot}`))
        .sort((a, b) => Number(a.relationship !== slot) - Number(b.relationship !== slot) || a.sort_order - b.sort_order || a.id - b.id);
      return candidates[0] ? { memberId: candidates[0].id as number, relationship: candidates[0].relationship as string } : null;
    };

    const diffs: Diff[] = [];
    const derivedById = new Map<number, Record<string, Value>>();
    let errors = 0;
    for (const { child_id: childId, family_id: familyId } of map) {
      const s = storedById.get(childId)!;
      const childName = `${s.fname} ${s.lname}`.trim();
      let derived: Record<string, Value>;
      try {
        const [result] = await db.query<RowDataPacket[][]>('CALL sp_family_preview(?, ?)', [childId, familyId]);
        derived = Object.fromEntries(Object.entries(result[0][0]).map(([k, v]) => [k, toValue(v)]));
      } catch (error) {
        errors++;
        diffs.push({ childId, childName, familyId, householdSize: sizes.get(familyId)!, column: '(all)', stored: null,
          derived: (error as Error).message, match: 'different', cause: 'derivation_error' });
        continue;
      }
      derivedById.set(childId, derived);

      const childRights = rights.filter((r) => r.child_id === childId);
      const ownMember = (slot: 'father' | 'mother') => childRights
        .map((r) => memberById.get(r.member_id))
        .filter((m) => m && (m.relationship === slot || m.relationship === `step_${slot}`))
        .sort((a, b) => a!.sort_order - b!.sort_order)[0]?.id ?? null;
      const ctx: ChildContext = {
        hasCai: s.has_cai === 1,
        householdSize: sizes.get(familyId)!,
        chosen: { father: chosenMember(familyId, 'father'), mother: chosenMember(familyId, 'mother') },
        own: { father: ownMember('father'), mother: ownMember('mother') },
        hasPayer: childRights.some((r) => r.is_payment_responsible && memberById.get(r.member_id)?.active),
        householdPhone: householdPhone.get(familyId) ?? '',
      };
      for (const col of COLUMNS) {
        const sv = toValue(s[col.name]);
        const dv = derived[col.name];
        const match = compare(sv, dv, col.kind);
        if (match === 'exact') continue;
        diffs.push({
          childId, childName, familyId, householdSize: ctx.householdSize, column: col.name,
          stored: sv, derived: dv, match, cause: classify(col.name, col.table, sv, dv, match, ctx),
        });
      }
    }

    await db.rollback();
    const after = await checksums(db);
    if (after !== before) throw new Error('table checksums changed during the proof run');

    const report = buildReport({ run, database, checked: map.length, stored, derivedById, diffs, errors });
    const out = resolve(args.out ?? join(API_ROOT, 'docs', 'family', 'family-sync-proof.md'));
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, report.markdown);
    const csvDir = resolve(args['csv-dir'] ?? join(API_ROOT, 'var', 'family-proof'));
    mkdirSync(csvDir, { recursive: true });
    const csv = join(csvDir, `family-sync-proof-run-${run.id}.csv`);
    writeFileSync(csv, report.csv);

    console.log(report.consoleSummary);
    console.log(`\nReport (ids and counts): ${relative(process.cwd(), out)}`);
    console.log(`Full diff (personal data): ${relative(process.cwd(), csv)}`);
    console.log('Read-only check: table checksums identical before and after.');
    if (report.failures > 0) process.exitCode = 1;
  } finally {
    await db.end();
  }
}

// ---------------------------------------------------------------------------------------------
// Report: the Markdown file holds counts and child ids only (no names, emails, phones or
// addresses); values are in the git-ignored CSV.

interface ReportInput {
  run: RowDataPacket; database: string; checked: number; stored: RowDataPacket[];
  derivedById: Map<number, Record<string, Value>>; diffs: Diff[]; errors: number;
}

const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const csvValue = (v: Value) => (v === null ? '' : String(v));
const ids = (list: number[]) => [...new Set(list)].sort((a, b) => a - b).join(', ');

/** Candidate home_send_notification rules, evaluated on the derived (draft family) values. */
const HOME_SEND_RULES: { name: string; rule: (d: Record<string, Value>) => number }[] = [
  { name: 'Always 0', rule: () => 0 },
  { name: 'Always 1', rule: () => 1 },
  { name: '1 when household_phone is set', rule: (d) => Number(String(d.home_phone ?? '') !== '') },
  { name: '1 when a parent receives notifications for the child', rule: (d) => Number(d.use_father_phone_for_notification === 1 || d.use_mother_phone_for_notification === 1) },
  { name: '1 when household_phone is set and no parent receives notifications (home line as fallback)',
    rule: (d) => Number(String(d.home_phone ?? '') !== '' && d.use_father_phone_for_notification !== 1 && d.use_mother_phone_for_notification !== 1) },
  { name: '1 when household_phone is set and a parent receives notifications',
    rule: (d) => Number(String(d.home_phone ?? '') !== '' && (d.use_father_phone_for_notification === 1 || d.use_mother_phone_for_notification === 1)) },
];

function buildReport({ run, database, checked, stored, derivedById, diffs, errors }: ReportInput) {
  const storedById = new Map(stored.map((r) => [r.id as number, r]));
  const allowed = new Set<Cause>(ALLOWED_CAUSES);
  const failuresList = diffs.filter((d) => !allowed.has(d.cause));
  const childrenWithDiffs = new Set(diffs.map((d) => d.childId));
  const childrenFailing = new Set(failuresList.map((d) => d.childId));

  const perColumn = COLUMNS.map((col) => {
    const d = diffs.filter((x) => x.column === col.name);
    const by = (m: Match) => d.filter((x) => x.match === m).length;
    return { col, total: d.length, nullEmpty: by('null_vs_empty'), ws: by('trim_casefold'), phone: by('phone_normalized'), different: by('different') };
  });
  const causes = (Object.keys(CAUSES) as Cause[])
    .map((cause) => {
      const d = diffs.filter((x) => x.cause === cause);
      return { cause, n: d.length, children: ids(d.map((x) => x.childId)), childCount: new Set(d.map((x) => x.childId)).size,
        columns: [...new Set(d.map((x) => x.column))].join(', ') };
    })
    .filter((x) => x.n > 0);

  const hsStored = new Map<string, number>();
  for (const r of stored) { const k = r.home_send_notification === null ? 'NULL' : String(r.home_send_notification); hsStored.set(k, (hsStored.get(k) ?? 0) + 1); }
  const ruleResults = HOME_SEND_RULES.map(({ name, rule }) => {
    let matches = 0;
    for (const [childId, d] of derivedById) if (rule(d) === Number(storedById.get(childId)!.home_send_notification)) matches++;
    return { name, matches, evaluated: derivedById.size };
  });

  const lines: string[] = [];
  const p = (s = '') => lines.push(s);
  p('# Family sync proof run');
  p();
  p(`Generated ${new Date().toLocaleString('sv-SE').slice(0, 16)} (local time) by \`scripts/family/proof-run.ts\` against \`${database}\` (2026-09-24 dump), ` +
    `backfill run ${run.id}${run.options ? ` (\`--${run.options}\`)` : ' (D3 grouping as written)'}. ` +
    'Read-only: every query ran in a READ ONLY transaction and the checksums of the legacy and family tables were identical before and after.');
  p();
  p('This file holds counts and child ids only. Names and values are in the git-ignored ' +
    `\`var/family-proof/family-sync-proof-run-${run.id}.csv\` (personal data).`);
  p();
  p(`## Result: ${failuresList.length === 0 ? 'PASS' : 'FAIL'}`);
  p();
  p('Target: the mirror fills the legacy columns exactly as they are filled today. The only accepted differences are: ' +
    `${ALLOWED_CAUSES.map((c) => CAUSES[c].replace(/^./, (x) => x.toLowerCase())).join('; ')}.`);
  p();
  p('| | Children | Differences |');
  p('| --- | ---: | ---: |');
  p(`| Checked | ${checked} | |`);
  p(`| With 0 differences | ${checked - childrenWithDiffs.size} | |`);
  p(`| With accepted differences only | ${childrenWithDiffs.size - childrenFailing.size} | ${diffs.length - failuresList.length} |`);
  p(`| **Failing** (any other difference) | **${childrenFailing.size}** | **${failuresList.length}** |`);
  p(`| sp_family_preview errors | ${errors} | |`);
  p();
  p('## How values are compared');
  p();
  p('`CALL sp_family_preview(child_id, draft_family_id)` gives the 28 values the mirror would write (`home_send_notification` is not mirrored). They are compared with today\'s `children` and `children_additional_information` values:');
  p();
  p('- **exact**: identical, NULL equals only NULL. Anything else is a difference, classified by the strictest of:');
  p('- **null_vs_empty**: one side NULL, the other `\'\'`.');
  p('- **trim_casefold**: strings equal after trimming, collapsing inner whitespace and lower-casing.');
  p('- **phone_normalized**: phones different as typed, same normalized number (extension dropped, digits only, last 10).');
  p('- **different**: none of the above. Bit and enum columns are compared by value only.');
  p();
  p('## Differences per likely cause');
  p();
  p('| Likely cause | Accepted | Differences | Children | Columns | Child ids |');
  p('| --- | --- | ---: | ---: | --- | --- |');
  for (const c of causes) {
    p(`| ${CAUSES[c.cause]} | ${allowed.has(c.cause) ? 'yes' : '**no**'} | ${c.n} | ${c.childCount} | ${c.columns} | ${c.children} |`);
  }
  if (causes.length === 0) p('| (none) | | 0 | 0 | | |');
  p();
  p('## Differences per column');
  p();
  p('| Column | Table | Differences | NULL vs empty | Whitespace/case only | Phone format only | Different |');
  p('| --- | --- | ---: | ---: | ---: | ---: | ---: |');
  for (const r of perColumn) {
    p(`| \`${r.col.name}\` | ${r.col.table === 'children' ? 'children' : 'CAI'} | ${r.total} | ${r.nullEmpty} | ${r.ws} | ${r.phone} | ${r.different} |`);
  }
  p();
  p('## home_send_notification');
  p();
  p('Not mirrored: the mirror owns 28 columns and this one stays as stored until production data shows its rule (SCHEMA.md). ' +
    `Stored values across the ${stored.length} children checked: ${[...hsStored].map(([k, n]) => `${k} = ${n}`).join(', ')}. ` +
    'Candidate rules, evaluated on the draft family values, for the production run to decide:');
  p();
  p('| Candidate rule | Matching children | Of |');
  p('| --- | ---: | ---: |');
  for (const r of ruleResults) p(`| ${r.name} | ${r.matches} | ${r.evaluated} |`);
  p();
  if (hsStored.size === 1) {
    p(`Every stored value is ${[...hsStored.keys()][0]}, so this dump cannot tell the candidate rules apart.`);
    p();
  }

  const csvLines = ['child_id,child_name,family_id,household_size,column,stored,stored_is_null,derived,derived_is_null,match,likely_cause,accepted'];
  for (const d of diffs) {
    csvLines.push([String(d.childId), d.childName, String(d.familyId), String(d.householdSize), d.column,
      csvValue(d.stored), String(d.stored === null), csvValue(d.derived), String(d.derived === null), d.match, d.cause,
      String(allowed.has(d.cause))].map(csvCell).join(','));
  }

  const consoleSummary = [
    `Run ${run.id}${run.options ? ` (${run.options})` : ''}: ${checked} children checked -> ${failuresList.length === 0 ? 'PASS' : 'FAIL'}`,
    `  0 differences: ${checked - childrenWithDiffs.size}; accepted differences only: ${childrenWithDiffs.size - childrenFailing.size}; failing: ${childrenFailing.size}`,
    `  differences: ${diffs.length} (failures: ${failuresList.length}), preview errors: ${errors}`,
    '  by cause:',
    ...causes.map((c) => `    ${c.cause.padEnd(26)} ${allowed.has(c.cause) ? 'accepted' : 'FAILURE '} ${String(c.n).padStart(5)} diffs, children ${c.children}`),
  ].join('\n');

  return { markdown: `${lines.join('\n')}\n`, csv: `${csvLines.join('\n')}\n`, consoleSummary, failures: failuresList.length };
}

main().catch((error: Error) => {
  console.error(`error: ${error.message}`);
  process.exitCode = 1;
});
