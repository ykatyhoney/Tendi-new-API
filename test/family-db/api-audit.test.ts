// audit_logs rows of Family API writes, through the app against tendi_family_test: each PATCH
// writes exactly the columns it changed (one row each), an unchanged value writes nothing, a
// failed write leaves no row, and every row has the full shape (type 'family_api', the staff
// member, actor_type 'admin', the row id, a readable entity_name). Link and unlink write one
// children.family_id row each. Rows created here are removed in after(); names start with a
// run-specific marker. Linking happens in this database only (backend CLAUDE.md rule 7).

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import type { Connection, RowDataPacket } from 'mysql2/promise';
import { buildApp, type App } from '../../src/app.ts';
import { loadConfig } from '../../src/config.ts';
import { connectLocal, loadEnv, requireEnv } from '../../scripts/family/lib/db.ts';

const MARK = `Za${randomBytes(3).toString('hex')}`;
let admin: Connection;
let app: App;
let adminId = 0;
const token = randomBytes(24).toString('hex');
const touchedChildren: number[] = [];

async function ok(method: 'POST' | 'PATCH' | 'PUT', url: string, payload?: object, status = 200) {
  const res = await app.inject({ method, url, payload, headers: { authorization: `Bearer ${token}` } });
  assert.equal(res.statusCode, status, `${method} ${url}: ${res.body}`);
  return res.json();
}

/** Every audit_logs column of the rows for this table row, oldest first. */
async function auditRows(table: string, id: number) {
  const [rows] = await admin.query<RowDataPacket[]>(
    `SELECT type, table_name, action, col_name, old_value, new_value, user_id, actor_type, actor_ref, device_id,
            table_id, entity_name
       FROM audit_logs WHERE table_name = ? AND table_id = ? ORDER BY id`,
    [table, id],
  );
  return rows.map((r) => ({ ...r }));
}

/** The rows a request added for this table row: [col_name, old_value, new_value]. */
async function rowsAddedBy(table: string, id: number, request: () => Promise<unknown>) {
  const before = (await auditRows(table, id)).length;
  await request();
  return (await auditRows(table, id)).slice(before);
}
const changes = (rows: Record<string, unknown>[]) => rows.map((r) => [r.action, r.col_name, r.old_value, r.new_value]);

before(async () => {
  loadEnv();
  const database = requireEnv('DB_TEST_NAME');
  admin = await connectLocal(database);
  const [[a]] = await admin.query<RowDataPacket[]>("SELECT id FROM admin WHERE type = 'office' AND status = 'active' LIMIT 1");
  adminId = a.id;
  await admin.query(
    `INSERT INTO admin_api_tokens (admin_id, token_hash, device_id, created_at, last_seen_at)
     VALUES (?, MD5(?), 'family-audit-test', NOW(), NOW())`,
    [adminId, token],
  );
  const config = loadConfig();
  app = await buildApp({ ...config, logLevel: 'silent', redisUrl: undefined, db: { ...config.db, database } });
});

after(async () => {
  await app?.close();
  if (touchedChildren.length) {
    await admin.query('UPDATE children SET family_id = NULL WHERE id IN (?)', [touchedChildren]);
    await admin.query("DELETE FROM audit_logs WHERE actor_ref = 'family-api' AND table_name = 'children' AND table_id IN (?)", [touchedChildren]);
  }
  await admin.query("DELETE FROM audit_logs WHERE actor_ref = 'family-api' AND entity_name LIKE ?", [`%${MARK}%`]);
  const [fams] = await admin.query<RowDataPacket[]>('SELECT id FROM families WHERE name LIKE ?', [`${MARK}%`]);
  const familyIds = fams.map((f) => f.id);
  if (familyIds.length) {
    await admin.query(
      'DELETE fmc FROM family_member_children fmc JOIN family_members fm ON fm.id = fmc.member_id WHERE fm.family_id IN (?)',
      [familyIds],
    );
    await admin.query('DELETE FROM family_members WHERE family_id IN (?)', [familyIds]);
    await admin.query('DELETE FROM families WHERE id IN (?)', [familyIds]);
  }
  await admin.query('DELETE FROM people WHERE lname LIKE ?', [`${MARK}%`]); // phones and addresses cascade
  await admin.query("DELETE FROM admin_api_tokens WHERE device_id = 'family-audit-test'");
  await admin.end();
});

describe('audit_logs of Family API writes', () => {
  test('PATCH /families/:id: one full row for the changed column only; the same values again write nothing', async () => {
    const family = await ok('POST', '/families', { name: `${MARK} Katz`, household_phone: '718-555-0100' }, 201);
    const rows = await rowsAddedBy('families', family.id, () =>
      ok('PATCH', `/families/${family.id}`, { name: `${MARK} Katz-Levi`, household_phone: '718-555-0100' }),
    );
    assert.deepEqual(rows, [
      {
        type: 'family_api',
        table_name: 'families',
        action: 'update',
        col_name: 'name',
        old_value: `${MARK} Katz`,
        new_value: `${MARK} Katz-Levi`,
        user_id: adminId,
        actor_type: 'admin',
        actor_ref: 'family-api',
        device_id: null,
        table_id: family.id,
        entity_name: `Family ${MARK} Katz-Levi`,
      },
    ]);
    assert.deepEqual(
      await rowsAddedBy('families', family.id, () =>
        ok('PATCH', `/families/${family.id}`, { name: `${MARK} Katz-Levi`, household_phone: '718-555-0100' }),
      ),
      [],
    );
  });

  test('PATCH /people/:id: the changed columns (and the derived legacy_full_name), not the unchanged ones', async () => {
    const family = await ok('POST', '/families', { name: `${MARK} People` }, 201);
    const m = await ok(
      'POST',
      `/families/${family.id}/members`,
      { person: { fname: 'Avi', lname: `${MARK}ln`, email: 'avi@example.test', hebrew_name: 'אבי' }, relationship: 'father' },
      201,
    );
    const rows = await rowsAddedBy('people', m.person_id, () =>
      ok('PATCH', `/people/${m.person_id}`, {
        fname: 'Avraham',
        lname: `${MARK}ln`, // unchanged
        email: 'avi@example.test', // unchanged
        hebrew_name: 'אבי', // unchanged
        note: 'prefers sms',
      }),
    );
    assert.deepEqual(changes(rows), [
      ['update', 'fname', 'Avi', 'Avraham'],
      ['update', 'note', null, 'prefers sms'],
      ['update', 'legacy_full_name', `Avi ${MARK}ln`, `Avraham ${MARK}ln`],
    ]);
    assert.ok(rows.every((r) => r.type === 'family_api' && r.user_id === adminId && r.actor_type === 'admin' && r.table_id === m.person_id));
    assert.equal(rows[0].entity_name, `Person Avi ${MARK}ln`);
  });

  test('PATCH /families/:id/members/:memberId: only the changed column; booleans as 1 / 0', async () => {
    const family = await ok('POST', '/families', { name: `${MARK} Members` }, 201);
    const m = await ok('POST', `/families/${family.id}/members`, { person: { fname: 'Sara', lname: `${MARK}ln` }, relationship: 'mother' }, 201);
    const rows = await rowsAddedBy('family_members', m.id, () =>
      ok('PATCH', `/families/${family.id}/members/${m.id}`, { relationship: 'mother', is_primary: true, sort_order: 0 }),
    );
    assert.deepEqual(changes(rows), [['update', 'is_primary', '0', '1']]);
    assert.equal(rows[0].entity_name, `Family ${MARK} Members`);
  });

  test('a failed write leaves no audit row', async () => {
    const family = await ok('POST', '/families', { name: `${MARK} Failed` }, 201);
    const m = await ok('POST', `/families/${family.id}/members`, { person: { fname: 'Dov', lname: `${MARK}ln` }, relationship: 'uncle' }, 201);
    const rows = await rowsAddedBy('people', m.person_id, async () => {
      // legacy_full_name "fname lname" would exceed 100 characters: 400, rolled back.
      await ok('PATCH', `/people/${m.person_id}`, { fname: 'D'.repeat(100), note: 'never saved' }, 400);
    });
    assert.deepEqual(rows, []);
  });

  test('link and unlink: one children.family_id row each', async () => {
    const [[child]] = await admin.query<RowDataPacket[]>(
      `SELECT c.id FROM children c JOIN children_additional_information cai ON cai.child_id = c.id
        WHERE c.status = 'active' AND c.family_id IS NULL ORDER BY c.id LIMIT 1 OFFSET 7`,
    );
    touchedChildren.push(child.id);
    const family = await ok('POST', '/families', { name: `${MARK} Link` }, 201);
    const m = await ok('POST', `/families/${family.id}/members`, { person: { fname: 'Eli', lname: `${MARK}ln` }, relationship: 'father' }, 201);
    await ok('PUT', `/families/${family.id}/children/${child.id}/rights`, { rights: [{ member_id: m.id }] });

    const linked = await rowsAddedBy('children', child.id, () => ok('POST', `/families/${family.id}/children/${child.id}/link`));
    const unlinked = await rowsAddedBy('children', child.id, () => ok('POST', `/children/${child.id}/unlink`));
    const shape = { type: 'family_api', table_name: 'children', col_name: 'family_id', user_id: adminId, actor_type: 'admin', table_id: child.id };
    assert.deepEqual(linked, [
      { ...linked[0], ...shape, action: 'link', old_value: null, new_value: String(family.id), entity_name: `Family ${MARK} Link: child ${child.id}` },
    ]);
    assert.deepEqual(unlinked, [
      { ...unlinked[0], ...shape, action: 'unlink', old_value: String(family.id), new_value: null, entity_name: `Family ${MARK} Link: child ${child.id}` },
    ]);
  });
});
