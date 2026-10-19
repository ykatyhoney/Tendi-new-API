// Nightly reconciliation (scripts/family/reconcile/run.ts): reports drift and lock-log activity
// for linked children, records a summary row, and never changes the data it checks.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { rows, useTestDatabase, value } from './support/db.ts';
import { createParents, link, pickChildren, storedLegacy } from './support/family.ts';
import { collectDrift, recordRun } from '../../scripts/family/reconcile/run.ts';

const db = useTestDatabase();

async function twoLinkedChildren() {
  const children = await pickChildren(db(), 2);
  const family = await createParents(db(), children);
  for (const child of children) await link(db(), child, family.familyId);
  return { children, ...family };
}

describe('reconcile', () => {
  test('freshly linked children: no drift', async () => {
    await twoLinkedChildren();
    const result = await collectDrift(db());
    assert.equal(result.linkedChildren, 2);
    assert.equal(result.driftedChildren, 0);
    assert.equal(result.lockLogRows, 0);
  });

  test('a write that bypassed the lock is reported as drift and left as it is', async () => {
    const { children: [drifted] } = await twoLinkedChildren();
    await db().query("SET @family_mirror = 1");
    await db().query("UPDATE children SET father_phone = '000' WHERE id = ?", [drifted]);
    await db().query('SET @family_mirror = NULL');
    const before = await storedLegacy(db(), drifted);

    const result = await collectDrift(db());

    assert.equal(result.driftedChildren, 1);
    assert.deepEqual(result.drifted[0].columns, [{ column: 'father_phone', stored: '000', derived: '347-555-0111', match: 'different' }]);
    assert.deepEqual(await storedLegacy(db(), drifted), before, 'reconciliation never fixes data');
  });

  test('reverted legacy writes in the last 24 hours are counted, and are not drift', async () => {
    const { children: [child] } = await twoLinkedChildren();
    await db().query("UPDATE children SET father_phone = '000', mother_name = 'X' WHERE id = ?", [child]);
    const result = await collectDrift(db());
    assert.equal(result.driftedChildren, 0);
    assert.equal(result.lockLogRows, 2);
    assert.deepEqual(result.lockLog.map((l) => `${l.table}.${l.column}`).sort(), ['children.father_phone', 'children.mother_name']);
  });

  test('recordRun writes one summary row with valid JSON details', async () => {
    const { children: [drifted] } = await twoLinkedChildren();
    await db().query("SET @family_mirror = 1");
    await db().query("UPDATE children_additional_information SET father_email = 'x@example.test' WHERE child_id = ?", [drifted]);
    await db().query('SET @family_mirror = NULL');

    const id = await recordRun(db(), await collectDrift(db()), 'manual');

    const [row] = await rows(db(), `SELECT trigger_source, linked_children, drifted_children, lock_log_rows, run_date = CURDATE() AS today,
                                           JSON_VALID(details) AS valid, JSON_EXTRACT(details, '$.drifted[0].columns[0].column') AS col
                                      FROM family_reconcile_runs WHERE id = ?`, [id]);
    assert.deepEqual({ ...row }, { trigger_source: 'manual', linked_children: 2, drifted_children: 1, lock_log_rows: 0, today: 1, valid: 1, col: 'father_email' });
  });

  test('unlinked children are not checked', async () => {
    await pickChildren(db(), 1);
    assert.equal(await value(db(), 'SELECT COUNT(*) FROM children WHERE family_id IS NOT NULL'), 0);
    assert.equal((await collectDrift(db())).linkedChildren, 0);
  });
});
