// Family reconciliation job (Phase 4 pilot). Compares every linked child's 28 mirrored columns
// with what the mirror derives now, counts lock log rows from the last 24 hours, writes one
// family_reconcile_runs row, and warns (exit code 2) when any child drifted. Never fixes data.
//
// Usage:
//   npm run family:reconcile                        nightly mode (run by the OS scheduler): skips
//                                                   if a scheduled run already exists for today
//   npm run family:reconcile -- --once              on demand: runs now, recorded as 'manual'
//   npm run family:reconcile -- --database <name>   target database (default DB_NAME)
//
// Exit codes: 0 no drift (or skipped), 2 drift found, 1 error.
// Single run: a MariaDB lock (GET_LOCK '<database>:family:reconcile') guards each run, so two
// scheduler hosts cannot run at once; the per-night check makes the second one skip. Redis
// replaces this in Step 2.3 (SET <prefix>:family:reconcile NX EX 3600).

import { parseArgs } from 'node:util';
import type { RowDataPacket } from 'mysql2/promise';
import { connectLocal, loadEnv, requireEnv } from './lib/db.ts';
import { alertDrift } from './reconcile/alert.ts';
import { collectDrift, recordRun } from './reconcile/run.ts';

const { values: args } = parseArgs({
  options: {
    once: { type: 'boolean', default: false },
    database: { type: 'string' },
  },
});

async function main() {
  loadEnv();
  const database = args.database ?? requireEnv('DB_NAME');
  const source = args.once ? 'manual' : 'scheduled';
  const lockName = `${database}:family:reconcile`;
  const started = performance.now();
  const db = await connectLocal(database);
  try {
    const [[lock]] = await db.query<RowDataPacket[]>('SELECT GET_LOCK(?, 0) AS got', [lockName]);
    if (lock.got !== 1) {
      console.log(`${new Date().toLocaleString('sv-SE')} family reconcile (${database}): another run holds ${lockName}; skipping.`);
      return;
    }
    try {
      if (source === 'scheduled') {
        const [[done]] = await db.query<RowDataPacket[]>(
          "SELECT id FROM family_reconcile_runs WHERE trigger_source = 'scheduled' AND run_date = CURDATE() ORDER BY id LIMIT 1");
        if (done) {
          console.log(`${new Date().toLocaleString('sv-SE')} family reconcile (${database}): tonight's run already happened (run ${done.id}); skipping.`);
          return;
        }
      }

      await db.query('START TRANSACTION READ ONLY');
      const result = await collectDrift(db);
      await db.query('COMMIT');
      const runId = await recordRun(db, result, source);

      const seconds = ((performance.now() - started) / 1000).toFixed(1);
      console.log([
        `${new Date().toLocaleString('sv-SE')} family reconcile run ${runId} (${database}, ${source}, ${seconds} s)`,
        `  linked children:      ${result.linkedChildren}`,
        `  drifted children:     ${result.driftedChildren}`,
        `  lock log rows (24 h): ${result.lockLogRows}${result.lockLog.length ? ` (${result.lockLog.map((l) => `${l.table}.${l.column}: ${l.rows}`).join(', ')})` : ''}`,
      ].join('\n'));
      for (const child of result.drifted) {
        console.log(`  drift: child ${child.childId}, family ${child.familyId}: ${child.error
          ? `preview error: ${child.error}`
          : child.columns.map((c) => `${c.column} stored ${JSON.stringify(c.stored)} / mirror ${JSON.stringify(c.derived)} (${c.match})`).join('; ')}`);
      }
      if (result.driftedChildren > 0) {
        alertDrift(runId, database, result);
        process.exitCode = 2;
      }
    } finally {
      await db.query('SELECT RELEASE_LOCK(?)', [lockName]);
    }
  } finally {
    await db.end();
  }
}

main().catch((error: Error) => {
  console.error(`error: ${error.message}`);
  process.exitCode = 1;
});
