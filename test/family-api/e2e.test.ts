// End to end through the database, as the app runs (its own family_api pool, committed writes):
// create a family -> add father and mother with phones -> set rights for two children -> preview
// -> link both -> edit the father's phone -> both children's father_phone updated -> a legacy-style
// UPDATE is put back and logged -> unlink one -> its values stay, and later family edits no longer
// reach it.
//
// Not rolled back (support/api.ts explains why): the legacy-style UPDATE runs as the test-only
// root account (DB_TEST_ROOT_USER, support/root.ts; tendi_family_test only), the way the PHP app
// writes, and must see the API's committed link. The test reads the two children's values before
// it starts (on a freshly reset database, the dump's values); a finally block unlinks them and
// writes those values back, and the test ends by asserting they match. after() removes every
// other row made here.

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import type { Connection, RowDataPacket } from 'mysql2/promise';
import { buildApp, type App } from '../../src/app.ts';
import { loadConfig } from '../../src/config.ts';
import { PREVIEW_COLUMNS } from '../../src/modules/family/repository/legacy.ts';
import { connectTestRoot, testDatabase } from './support/root.ts';

const MARK = `Ze${randomBytes(3).toString('hex')}`;
const DEVICE = 'family-api-e2e';
let root: Connection;
let app: App;
let adminId = 0;
const token = randomBytes(24).toString('hex');
let children: number[] = [];
const saved = new Map<number, { children: RowDataPacket; cai: RowDataPacket }>();

const BITS = new Set([
  'use_father_phone_for_notification',
  'use_mother_phone_for_notification',
  'home_send_notification',
]);
const select = (table: 'children' | 'children_additional_information') =>
  PREVIEW_COLUMNS.filter((c) => c.table === table).map((c) =>
    BITS.has(c.name) ? `${c.name} + 0 AS ${c.name}` : c.name,
  );

/** The 29 legacy columns of a child, plus children.note (not mirrored) and family_id. */
async function legacy(childId: number) {
  const [[c]] = await root.query<RowDataPacket[]>(
    `SELECT family_id, note, ${select('children').join(', ')} FROM children WHERE id = ?`,
    [childId],
  );
  const [[cai]] = await root.query<RowDataPacket[]>(
    `SELECT ${select('children_additional_information').join(', ')} FROM children_additional_information WHERE child_id = ?`,
    [childId],
  );
  return { children: { ...c }, cai: { ...cai } };
}

async function ok(method: 'GET' | 'POST' | 'PUT', url: string, payload?: object, status = 200) {
  const res = await app.inject({ method, url, payload, headers: { authorization: `Bearer ${token}` } });
  assert.equal(res.statusCode, status, `${method} ${url}: ${res.body}`);
  return res.json();
}

before(async () => {
  const database = testDatabase();
  root = await connectTestRoot();
  const [[a]] = await root.query<RowDataPacket[]>(
    "SELECT id FROM admin WHERE type = 'office' AND status = 'active' LIMIT 1",
  );
  adminId = a.id;
  await root.query(
    `INSERT INTO admin_api_tokens (admin_id, token_hash, device_id, created_at, last_seen_at)
     VALUES (?, MD5(?), ?, NOW(), NOW())`,
    [adminId, token, DEVICE],
  );
  const [rows] = await root.query<RowDataPacket[]>(
    `SELECT c.id FROM children c JOIN children_additional_information cai ON cai.child_id = c.id
      WHERE c.status = 'active' AND c.family_id IS NULL ORDER BY c.id DESC LIMIT 2`,
  );
  children = rows.map((r) => r.id);
  for (const id of children) saved.set(id, await legacy(id));
  const config = loadConfig();
  app = await buildApp({ ...config, logLevel: 'silent', redisUrl: undefined, db: { ...config.db, database } });
});

/** Unlinks the two children and writes back the values read before the test. */
async function restoreChildren() {
  if (children.length === 0) return;
  await root.query('UPDATE children SET family_id = NULL WHERE id IN (?)', [children]);
  for (const [id, values] of saved) {
    // Unlinked now, so the lock no longer applies.
    await root.query('UPDATE children SET ? WHERE id = ?', [values.children, id]);
    await root.query('UPDATE children_additional_information SET ? WHERE child_id = ?', [values.cai, id]);
  }
}

after(async () => {
  await app?.close();
  if (!root) return;
  if (children.length) {
    await root.query('DELETE FROM family_mirror_lock_log WHERE child_id IN (?)', [children]);
    await root.query(
      "DELETE FROM audit_logs WHERE actor_ref = 'family-api' AND table_name = 'children' AND table_id IN (?)",
      [children],
    );
  }
  await root.query("DELETE FROM audit_logs WHERE actor_ref = 'family-api' AND entity_name LIKE ?", [`%${MARK}%`]);
  const [fams] = await root.query<RowDataPacket[]>('SELECT id FROM families WHERE name LIKE ?', [`${MARK}%`]);
  const familyIds = fams.map((f) => f.id);
  if (familyIds.length) {
    await root.query(
      'DELETE fmc FROM family_member_children fmc JOIN family_members fm ON fm.id = fmc.member_id WHERE fm.family_id IN (?)',
      [familyIds],
    );
    await root.query('DELETE FROM family_members WHERE family_id IN (?)', [familyIds]);
    await root.query('DELETE FROM families WHERE id IN (?)', [familyIds]);
  }
  await root.query('DELETE FROM people WHERE lname = ?', [`${MARK}ln`]); // phones and addresses cascade
  await root.query('DELETE FROM admin_api_tokens WHERE device_id = ?', [DEVICE]);
  await root.end();
});

describe('a family from creation to unlink, through the database', () => {
  test('create, members with phones, rights, preview, link, edit, lock, unlink', async () => {
    try {
      await journey();
    } finally {
      await restoreChildren();
    }
    // The children are back to the values they had before (the dump's, after the suite's reset).
    for (const id of children) assert.deepEqual(await legacy(id), saved.get(id), `child ${id} restored`);
  });
});

async function journey() {
  const [first, second] = children;

  // Create the household; add the father and the mother, each with a primary phone.
  const family = await ok('POST', '/families', { name: `${MARK} Katz`, household_phone: '718-555-0400' }, 201);
  const father = await ok(
    'POST',
    `/families/${family.id}/members`,
    {
      person: { fname: 'Avi', lname: `${MARK}ln`, email: 'avi@example.test' },
      relationship: 'father',
      is_primary: true,
    },
    201,
  );
  const mother = await ok(
    'POST',
    `/families/${family.id}/members`,
    {
      person: { fname: 'Sara', lname: `${MARK}ln`, email: 'sara@example.test' },
      relationship: 'mother',
      sort_order: 1,
    },
    201,
  );
  await ok('PUT', `/people/${father.person_id}/phones`, {
    phones: [{ phone: '347-555-0101', label: 'mobile', is_primary: true }],
  });
  await ok('PUT', `/people/${mother.person_id}/phones`, {
    phones: [
      { phone: '347-555-0202', label: 'mobile', is_primary: true },
      { phone: '718-555-0203', label: 'work' },
    ],
  });

  // Rights for both children: the father gets the notifications (sms), the mother pays.
  for (const child of children) {
    const res = await ok('PUT', `/families/${family.id}/children/${child}/rights`, {
      rights: [
        { member_id: father.id, receives_notifications: true, notify_method: 'sms', may_collect: true },
        { member_id: mother.id, is_payment_responsible: true, may_collect: true },
      ],
    });
    assert.equal(res.rights.length, 2);
    assert.equal(res.warning, undefined, 'not linked yet: no legacy value changes');
  }

  // Preview: what linking will write, with nothing to warn about.
  const preview = await ok('GET', `/families/${family.id}/children/${first}/preview`);
  const after = Object.fromEntries(
    preview.columns.map((c: { column: string; after_link: unknown }) => [c.column, c.after_link]),
  );
  assert.deepEqual(preview.warnings, []);
  assert.deepEqual(
    [
      after.father_name,
      after.father_phone,
      after.mother_phone,
      after.home_phone,
      after.parent_email,
      after.use_father_phone_for_notification,
      after.notification_father_phone_method,
      after.mother_office_phone,
    ],
    [`Avi ${MARK}ln`, '347-555-0101', '347-555-0202', '718-555-0400', 'sara@example.test', 1, 'sms', '718-555-0203'],
  );
  assert.deepEqual(await legacy(first), saved.get(first), 'the preview wrote nothing');

  // Link both: the database mirror fills their legacy columns.
  for (const child of children) {
    const linked = await ok('POST', `/families/${family.id}/children/${child}/link`);
    assert.deepEqual(
      linked.columns.filter((c: { changed: boolean }) => c.changed),
      [],
    );
    const now = await legacy(child);
    assert.deepEqual(
      [
        now.children.family_id,
        now.children.father_phone,
        now.children.mother_phone,
        now.children.parent_email,
        now.cai.father_fname,
        now.cai.mother_office_phone,
      ],
      [family.id, '347-555-0101', '347-555-0202', 'sara@example.test', 'Avi', '718-555-0203'],
    );
  }

  // Edit the father's phone once: both children's father_phone follow.
  const edited = await ok('PUT', `/people/${father.person_id}/phones`, {
    phones: [{ phone: '347-555-0999', label: 'mobile', is_primary: true }],
  });
  assert.deepEqual([...edited.warning.affected_child_ids].sort(), [...children].sort());
  for (const child of children) assert.equal((await legacy(child)).children.father_phone, '347-555-0999');

  // A legacy-style UPDATE (the PHP child form saves every field): the parent field is put back
  // and logged, the other field saves.
  await root.query("UPDATE children SET father_phone = '000-000-0000', note = ? WHERE id = ?", [`${MARK} note`, first]);
  const locked = await legacy(first);
  assert.deepEqual([locked.children.father_phone, locked.children.note], ['347-555-0999', `${MARK} note`]);
  const [log] = await root.query<RowDataPacket[]>(
    'SELECT table_name, col_name, attempted_value, kept_value FROM family_mirror_lock_log WHERE child_id = ? ORDER BY id',
    [first],
  );
  assert.deepEqual(
    log.map((r) => ({ ...r })),
    [
      {
        table_name: 'children',
        col_name: 'father_phone',
        attempted_value: '000-000-0000',
        kept_value: '347-555-0999',
      },
    ],
  );

  // Unlink the second child: every value stays as the mirror left it.
  const beforeUnlink = await legacy(second);
  assert.deepEqual(await ok('POST', `/children/${second}/unlink`), { child_id: second, family_id: null });
  assert.deepEqual(await legacy(second), {
    ...beforeUnlink,
    children: { ...beforeUnlink.children, family_id: null },
  });

  // A later family edit reaches the linked child only; the unlinked one keeps its values.
  const again = await ok('PUT', `/people/${father.person_id}/phones`, {
    phones: [{ phone: '347-555-0888', label: 'mobile', is_primary: true }],
  });
  assert.deepEqual(again.warning.affected_child_ids, [first]);
  assert.equal((await legacy(first)).children.father_phone, '347-555-0888');
  assert.equal((await legacy(second)).children.father_phone, '347-555-0999');

  // And the child form owns the unlinked child's parent columns again.
  await root.query("UPDATE children SET father_phone = '347-555-0111' WHERE id = ?", [second]);
  assert.equal((await legacy(second)).children.father_phone, '347-555-0111');
}
