// The lock (decision D2): legacy writes to mirrored columns of a linked child are put back and
// logged, other columns save normally; unlinked children behave exactly as today; unlinking
// keeps the last values and hands the columns back to the child form.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { RowDataPacket } from 'mysql2/promise';
import { rows, useTestDatabase, value } from './support/db.ts';
import { createParents, link, lockLogCount, pickChildren, preview, storedLegacy } from './support/family.ts';

const db = useTestDatabase();

async function linkedChild() {
  const [child] = await pickChildren(db(), 1);
  const family = await createParents(db(), [child]);
  await link(db(), child, family.familyId);
  return { child, ...family };
}

describe('lock', () => {
  test('linking mirrors all 28 columns and logs nothing', async () => {
    const { child } = await linkedChild();
    assert.deepEqual(await storedLegacy(db(), child), await preview(db(), child));
    assert.equal(await lockLogCount(db(), child), 0);
    const [[flag]] = await db().query<RowDataPacket[]>('SELECT @family_mirror AS f');
    assert.equal(flag.f, null, '@family_mirror is reset after linking');
  });

  test('legacy UPDATE on a linked child: mirrored column put back and logged, other field saved', async () => {
    const { child } = await linkedChild();
    await db().query("UPDATE children SET father_phone = '000', note = 'legacy edit' WHERE id = ?", [child]);

    const [row] = await rows(db(), 'SELECT father_phone, note FROM children WHERE id = ?', [child]);
    assert.equal(row.father_phone, '347-555-0111');
    assert.equal(row.note, 'legacy edit');
    const log = await rows(db(), 'SELECT table_name, col_name, attempted_value, kept_value, db_user FROM family_mirror_lock_log WHERE child_id = ?', [child]);
    assert.equal(log.length, 1);
    assert.deepEqual({ ...log[0], db_user: undefined },
      { table_name: 'children', col_name: 'father_phone', attempted_value: '000', kept_value: '347-555-0111', db_user: undefined });
    assert.match(log[0].db_user, /@/, 'db_user is the connected client, user@host');
  });

  test('legacy UPDATE posting unchanged mirrored values logs nothing', async () => {
    const { child } = await linkedChild();
    await db().query("UPDATE children SET father_phone = father_phone, mother_name = mother_name, note = 'x' WHERE id = ?", [child]);
    assert.equal(await lockLogCount(db(), child), 0);
  });

  test('legacy UPDATE of bit and enum columns on a linked child is put back', async () => {
    const { child } = await linkedChild();
    await db().query(`UPDATE children SET use_father_phone_for_notification = b'0', notification_mother_phone_method = 'both'
                      WHERE id = ?`, [child]);
    const v = await storedLegacy(db(), child);
    assert.equal(v.use_father_phone_for_notification, 1);
    assert.equal(v.notification_mother_phone_method, 'voice');
    const log = await rows(db(), 'SELECT col_name, attempted_value, kept_value FROM family_mirror_lock_log WHERE child_id = ? ORDER BY id', [child]);
    assert.deepEqual(log.map((r) => ({ ...r })), [
      { col_name: 'use_father_phone_for_notification', attempted_value: '0', kept_value: '1' },
      { col_name: 'notification_mother_phone_method', attempted_value: 'both', kept_value: 'voice' },
    ]);
  });

  test('legacy UPDATE of children_additional_information on a linked child is put back and logged', async () => {
    const { child } = await linkedChild();
    await db().query(`UPDATE children_additional_information
                         SET father_email = 'legacy@example.test', comments = 'legacy comment' WHERE child_id = ?`, [child]);
    const [row] = await rows(db(), 'SELECT father_email, comments FROM children_additional_information WHERE child_id = ?', [child]);
    assert.equal(row.father_email, 'avi@example.test');
    assert.equal(row.comments, 'legacy comment');
    const [log] = await rows(db(), 'SELECT table_name, col_name, attempted_value FROM family_mirror_lock_log WHERE child_id = ?', [child]);
    assert.deepEqual({ ...log }, { table_name: 'children_additional_information', col_name: 'father_email', attempted_value: 'legacy@example.test' });
  });

  test('home_send_notification is not mirrored or locked: linking keeps it, a legacy edit saves', async () => {
    const [child] = await pickChildren(db(), 1);
    await db().query("UPDATE children SET home_send_notification = b'1' WHERE id = ?", [child]);
    const family = await createParents(db(), [child]);
    await link(db(), child, family.familyId);
    assert.equal(await value(db(), 'SELECT home_send_notification + 0 FROM children WHERE id = ?', [child]), 1, 'linking keeps the stored value');

    await db().query("UPDATE children SET home_send_notification = b'0' WHERE id = ?", [child]);
    assert.equal(await value(db(), 'SELECT home_send_notification + 0 FROM children WHERE id = ?', [child]), 0);
    assert.equal(await lockLogCount(db(), child), 0);
  });

  test('same UPDATE on an unlinked child saves both fields and logs nothing', async () => {
    const [child] = await pickChildren(db(), 1);
    await db().query("UPDATE children SET father_phone = '000', note = 'legacy edit' WHERE id = ?", [child]);
    const [row] = await rows(db(), 'SELECT father_phone, note FROM children WHERE id = ?', [child]);
    assert.deepEqual({ ...row }, { father_phone: '000', note: 'legacy edit' });
    assert.equal(await lockLogCount(db(), child), 0);
  });

  test('unlink keeps all 28 mirrored values; legacy edits save again afterwards', async () => {
    const { child } = await linkedChild();
    const before = await storedLegacy(db(), child);

    await link(db(), child, null);
    assert.deepEqual(await storedLegacy(db(), child), before);

    await db().query("UPDATE children SET father_phone = '000' WHERE id = ?", [child]);
    await db().query("UPDATE children_additional_information SET father_email = 'legacy@example.test' WHERE child_id = ?", [child]);
    const after = await storedLegacy(db(), child);
    assert.equal(after.father_phone, '000');
    assert.equal(after.father_email, 'legacy@example.test');
    assert.equal(await lockLogCount(db(), child), 0);
  });

  test('a legacy write cannot bypass the lock by changing family_id in the same statement to the same family', async () => {
    const { child, familyId } = await linkedChild();
    await db().query("UPDATE children SET family_id = ?, father_phone = '000' WHERE id = ?", [familyId, child]);
    assert.equal(await value(db(), 'SELECT father_phone FROM children WHERE id = ?', [child]), '347-555-0111');
    assert.equal(await lockLogCount(db(), child), 1);
  });
});
