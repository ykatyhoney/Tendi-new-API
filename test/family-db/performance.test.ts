// PLAN.md "Testing": a family edit touching 5 linked siblings completes within the app's normal
// save time. Target: FAMILY_DB_PERF_TARGET_MS (default 200 ms), compared with the median of
// several runs so one slow sample does not fail the suite.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { timed, useTestDatabase } from './support/db.ts';
import { createParents, link, pickChildren, storedLegacy } from './support/family.ts';

const db = useTestDatabase();
const TARGET_MS = Number(process.env.FAMILY_DB_PERF_TARGET_MS ?? 200);
const RUNS = 7;

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

describe('performance', () => {
  for (const edit of ['people email', 'household phone', 'primary phone'] as const) {
    test(`${edit} edit on a family with 5 linked siblings: median under ${TARGET_MS} ms`, async (t) => {
      const children = await pickChildren(db(), 5);
      const family = await createParents(db(), children);
      for (const child of children) await link(db(), child, family.familyId);

      const samples: number[] = [];
      for (let run = 0; run < RUNS; run++) {
        const tag = `${run}${Date.now() % 1000}`;
        if (edit === 'people email') {
          samples.push(await timed(db(), 'UPDATE people SET email = ? WHERE id = ?', [`avi.${tag}@example.test`, family.fatherId]));
        } else if (edit === 'household phone') {
          samples.push(await timed(db(), 'UPDATE families SET household_phone = ? WHERE id = ?', [`718-555-${tag.padStart(4, '0').slice(-4)}`, family.familyId]));
        } else {
          samples.push(await timed(db(), 'UPDATE people_phones SET phone = ? WHERE person_id = ? AND is_primary = 1', [`347-555-${tag.padStart(4, '0').slice(-4)}`, family.fatherId]));
        }
      }

      const ms = median(samples);
      t.diagnostic(`samples (ms): ${samples.map((s) => s.toFixed(1)).join(', ')}; median ${ms.toFixed(1)}`);
      for (const child of children) {
        const v = await storedLegacy(db(), child);
        if (edit === 'people email') assert.match(String(v.father_email), /^avi\.\d+@example\.test$/);
      }
      assert.ok(ms < TARGET_MS, `median ${ms.toFixed(1)} ms is over the ${TARGET_MS} ms target`);
    });
  }
});
