// The existing ra_* audit triggers record the final, mirrored values (trg_children_family_au
// PRECEDES ra_children_au; the lock is a BEFORE trigger), attributed to @audit_user.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { rows, useTestDatabase, value } from './support/db.ts';
import type { Db } from './support/db.ts';
import { LEGACY_COLUMNS, createParents, link, pickChildren, storedLegacy } from './support/family.ts';
import type { Legacy } from './support/family.ts';

const db = useTestDatabase();

interface AuditRow { table_name: string; table_id: number; action: string; user_id: number; changes: Record<string, { old: unknown; new: unknown }> }

async function auditSince(conn: Db, startId: number): Promise<AuditRow[]> {
  const found = await rows(conn, `SELECT table_name, table_id, action, user_id, changed_fields FROM record_audit
                                   WHERE id > ? AND table_name IN ('children', 'children_additional_information') ORDER BY id`, [startId]);
  return found.map((r) => ({
    table_name: r.table_name, table_id: Number(r.table_id), action: r.action, user_id: r.user_id,
    changes: r.changed_fields ? JSON.parse(r.changed_fields) : {},
  }));
}

/** Every legacy column named in an audit row has, as "new", the value now stored. */
function assertAuditMatchesStored(audit: AuditRow, stored: Legacy) {
  const legacyChanges = Object.keys(audit.changes).filter((c) => LEGACY_COLUMNS.includes(c));
  assert.ok(legacyChanges.length > 0, `audit row for ${audit.table_name} names no legacy column`);
  for (const column of legacyChanges) {
    const expected = stored[column] === null ? null : String(stored[column]);
    assert.equal(audit.changes[column].new, expected, `${audit.table_name}.${column}`);
  }
}

describe('audit', () => {
  test('linking: ra_* rows for children and children_additional_information carry the mirrored values', async () => {
    const [child] = await pickChildren(db(), 1);
    const family = await createParents(db(), [child]);
    const start = await value<number>(db(), 'SELECT MAX(id) FROM record_audit');
    await db().query('SET @audit_user = 4242');

    await link(db(), child, family.familyId);

    const stored = await storedLegacy(db(), child);
    const caiId = await value<number>(db(), 'SELECT id FROM children_additional_information WHERE child_id = ?', [child]);
    const audit = await auditSince(db(), start);
    const childRow = audit.find((a) => a.table_name === 'children' && a.table_id === child);
    const caiRow = audit.find((a) => a.table_name === 'children_additional_information' && a.table_id === caiId);
    assert.ok(childRow && caiRow, 'both tables audited');
    assertAuditMatchesStored(childRow, stored);
    assertAuditMatchesStored(caiRow, stored);
    assert.equal(childRow.changes.father_name.new, 'Avi Test');
    assert.deepEqual([childRow.user_id, caiRow.user_id], [4242, 4242]);
  });

  test('a family edit: the audit row shows the re-mirrored value', async () => {
    const [child] = await pickChildren(db(), 1);
    const family = await createParents(db(), [child]);
    await link(db(), child, family.familyId);
    const start = await value<number>(db(), 'SELECT MAX(id) FROM record_audit');
    await db().query('SET @audit_user = 77');

    await db().query("UPDATE people_phones SET phone = '347-555-0777' WHERE person_id = ? AND is_primary = 1", [family.fatherId]);

    const [childRow] = (await auditSince(db(), start)).filter((a) => a.table_name === 'children');
    assert.deepEqual(childRow.changes, { father_phone: { old: '347-555-0111', new: '347-555-0777' } });
    assert.equal(childRow.user_id, 77);
    assertAuditMatchesStored(childRow, await storedLegacy(db(), child));
  });

  test('a reverted legacy write is not audited as a change; the other field is', async () => {
    const [child] = await pickChildren(db(), 1);
    const family = await createParents(db(), [child]);
    await link(db(), child, family.familyId);
    const start = await value<number>(db(), 'SELECT MAX(id) FROM record_audit');

    await db().query("UPDATE children SET father_phone = '000', note = 'legacy edit' WHERE id = ?", [child]);

    const audit = await auditSince(db(), start);
    assert.equal(audit.length, 1);
    assert.deepEqual(Object.keys(audit[0].changes), ['note']);
  });
});
