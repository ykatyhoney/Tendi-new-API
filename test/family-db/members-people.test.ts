// Step 3.5 through the app against tendi_family_test: the member routes (add, edit, remove) and the
// people routes (edit, replace phones, replace addresses), with the mirror warning. The app commits
// its writes, so every row created here is removed in after(); family names and surnames start
// with a run-specific marker. Linking children happens here only (backend CLAUDE.md rule 7).

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import type { Connection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { buildApp, type App } from '../../src/app.ts';
import { loadConfig } from '../../src/config.ts';
import { connectLocal, loadEnv, requireEnv } from '../../scripts/family/lib/db.ts';

const MARK = `Zm${randomBytes(3).toString('hex')}`;
const NO_ID = 2147483647;
let admin: Connection;
let app: App;
let adminId = 0;
const token = randomBytes(24).toString('hex');
const linkedChildren: number[] = [];
const people: number[] = [];

const api = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: object) =>
  app.inject({ method, url, payload, headers: { authorization: `Bearer ${token}` } });

async function ok(method: 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: object, status = 200) {
  const res = await api(method, url, payload);
  assert.equal(res.statusCode, status, `${method} ${url}: ${res.body}`);
  return res.json();
}

async function family(name: string, householdPhone = ''): Promise<number> {
  return (await ok('POST', '/families', { name: `${MARK} ${name}`, household_phone: householdPhone }, 201)).id;
}

async function newMember(familyId: number, fname: string, relationship: string, extra: object = {}) {
  const body = await ok(
    'POST',
    `/families/${familyId}/members`,
    { person: { fname, lname: `${MARK}ln` }, relationship, ...extra },
    201,
  );
  people.push(body.person_id);
  return body;
}

/** Links a free child to the family (as root, like the PHP form would) and returns its id. */
async function link(familyId: number): Promise<number> {
  const [[row]] = await admin.query<RowDataPacket[]>(
    `SELECT c.id FROM children c JOIN children_additional_information cai ON cai.child_id = c.id
      WHERE c.status = 'active' AND c.family_id IS NULL ORDER BY c.id DESC LIMIT 1`,
  );
  await admin.query('UPDATE children SET family_id = ? WHERE id = ?', [familyId, row.id]);
  linkedChildren.push(row.id);
  return row.id;
}

async function legacy(childId: number) {
  const [[row]] = await admin.query<RowDataPacket[]>(
    `SELECT c.father_name, c.father_phone, c.parent_email, c.use_father_phone_for_notification + 0 AS use_father,
            c.notification_father_phone_method AS father_method, cai.father_fname, cai.father_email, cai.father_address
       FROM children c LEFT JOIN children_additional_information cai ON cai.child_id = c.id WHERE c.id = ?`,
    [childId],
  );
  return { ...row };
}

/** A rights row written directly, so these tests do not depend on the rights route (step 3.6). */
async function right(memberId: number, childId: number, flags: Record<string, unknown> = {}): Promise<number> {
  const columns = {
    receives_notifications: 0,
    notify_method: 'sms',
    may_collect: 0,
    is_emergency: 0,
    is_payment_responsible: 0,
    ...flags,
  };
  const [r] = await admin.query<ResultSetHeader>(
    `INSERT INTO family_member_children (member_id, child_id, ${Object.keys(columns).join(', ')})
     VALUES (?, ?, ${Object.keys(columns)
       .map(() => '?')
       .join(', ')})`,
    [memberId, childId, ...Object.values(columns)],
  );
  return r.insertId;
}

/** A free child that stays unlinked, for the rights rows of a draft. */
async function freeChild(): Promise<number> {
  const [[row]] = await admin.query<RowDataPacket[]>(
    `SELECT c.id FROM children c JOIN children_additional_information cai ON cai.child_id = c.id
      WHERE c.status = 'active' AND c.family_id IS NULL ORDER BY c.id LIMIT 1 OFFSET ?`,
    [drafts++],
  );
  return row.id;
}
let drafts = 0;

async function audit(table: string, id: number) {
  const [rows] = await admin.query<RowDataPacket[]>(
    `SELECT action, col_name, old_value, new_value, user_id FROM audit_logs
      WHERE actor_ref = 'family-api' AND table_name = ? AND table_id = ? ORDER BY id`,
    [table, id],
  );
  return rows.map((r) => ({ ...r }));
}

before(async () => {
  loadEnv();
  const database = requireEnv('DB_TEST_NAME');
  admin = await connectLocal(database);
  const [[a]] = await admin.query<RowDataPacket[]>("SELECT id FROM admin WHERE type = 'office' AND status = 'active' LIMIT 1");
  adminId = a.id;
  await admin.query(
    `INSERT INTO admin_api_tokens (admin_id, token_hash, device_id, created_at, last_seen_at)
     VALUES (?, MD5(?), 'family-members-test', NOW(), NOW())`,
    [adminId, token],
  );
  const config = loadConfig();
  app = await buildApp({ ...config, logLevel: 'silent', redisUrl: undefined, db: { ...config.db, database } });
});

after(async () => {
  await app?.close();
  if (linkedChildren.length) await admin.query('UPDATE children SET family_id = NULL WHERE id IN (?)', [linkedChildren]);
  const [fams] = await admin.query<RowDataPacket[]>('SELECT id FROM families WHERE name LIKE ?', [`${MARK}%`]);
  const familyIds = fams.map((f) => f.id);
  const [pp] = await admin.query<RowDataPacket[]>('SELECT id FROM people WHERE lname LIKE ?', [`${MARK}%`]);
  const personIds = [...new Set([...people, ...pp.map((p) => p.id)])];
  if (familyIds.length) {
    const [members] = await admin.query<RowDataPacket[]>('SELECT id FROM family_members WHERE family_id IN (?)', [familyIds]);
    const memberIds = members.map((m) => m.id);
    if (memberIds.length) {
      await admin.query(
        `DELETE a FROM audit_logs a JOIN family_member_children fmc ON fmc.id = a.table_id
          WHERE a.actor_ref = 'family-api' AND a.table_name = 'family_member_children' AND fmc.member_id IN (?)`,
        [memberIds],
      );
      await admin.query('DELETE FROM family_member_children WHERE member_id IN (?)', [memberIds]);
      await admin.query("DELETE FROM audit_logs WHERE actor_ref = 'family-api' AND table_name = 'family_members' AND table_id IN (?)", [memberIds]);
    }
    await admin.query('DELETE FROM family_members WHERE family_id IN (?)', [familyIds]);
    await admin.query("DELETE FROM audit_logs WHERE actor_ref = 'family-api' AND table_name = 'families' AND table_id IN (?)", [familyIds]);
    await admin.query('DELETE FROM families WHERE id IN (?)', [familyIds]);
  }
  if (personIds.length) {
    await admin.query("DELETE FROM audit_logs WHERE actor_ref = 'family-api' AND table_name = 'people' AND table_id IN (?)", [personIds]);
    await admin.query('DELETE FROM people WHERE id IN (?)', [personIds]); // phones and addresses cascade
  }
  await admin.query("DELETE FROM admin_api_tokens WHERE device_id = 'family-members-test'");
  await admin.end();
});

describe('POST /families/:id/members', () => {
  test('a new person: legacy_full_name is "fname lname", created_by set, audit rows; no linked child, no warning', async () => {
    const familyId = await family('NewPerson');
    const m = await ok(
      'POST',
      `/families/${familyId}/members`,
      { person: { fname: 'Avi', lname: `${MARK}ln`, email: 'avi@example.test', occupation: 'Teacher' }, relationship: 'father', is_primary: true },
      201,
    );
    people.push(m.person_id);
    assert.deepEqual([m.family_id, m.relationship, m.is_primary, m.sort_order, m.status], [familyId, 'father', true, 0, 'active']);
    assert.deepEqual([m.person.fname, m.person.legacy_full_name, m.person.email, m.person.occupation], ['Avi', `Avi ${MARK}ln`, 'avi@example.test', 'Teacher']);
    assert.equal(m.warning, undefined);

    const [[row]] = await admin.query<RowDataPacket[]>('SELECT created_by, updated_by FROM people WHERE id = ?', [m.person_id]);
    assert.deepEqual({ ...row }, { created_by: adminId, updated_by: adminId });
    assert.deepEqual(
      (await audit('people', m.person_id)).map((r) => [r.action, r.col_name, r.new_value]),
      [
        ['create', 'fname', 'Avi'],
        ['create', 'lname', `${MARK}ln`],
        ['create', 'email', 'avi@example.test'],
        ['create', 'occupation', 'Teacher'],
        ['create', 'legacy_full_name', `Avi ${MARK}ln`],
      ],
    );
    assert.deepEqual(
      (await audit('family_members', m.id)).map((r) => [r.action, r.col_name, r.new_value, r.user_id]),
      [
        ['create', 'person_id', String(m.person_id), adminId],
        ['create', 'relationship', 'father', adminId],
        ['create', 'is_primary', '1', adminId],
        ['create', 'sort_order', '0', adminId],
      ],
    );
  });

  test('an existing person; once per family: 409 while active, brought back (200) after removal', async () => {
    const first = await family('Existing1');
    const second = await family('Existing2');
    const avi = await newMember(first, 'Avi', 'father');
    const m = await ok('POST', `/families/${second}/members`, { person_id: avi.person_id, relationship: 'uncle', sort_order: 3 }, 201);
    assert.deepEqual([m.person_id, m.relationship, m.sort_order], [avi.person_id, 'uncle', 3]);

    const dup = await api('POST', `/families/${second}/members`, { person_id: avi.person_id, relationship: 'father' });
    assert.equal(dup.statusCode, 409);
    assert.deepEqual(dup.json(), {
      statusCode: 409,
      error: 'Conflict',
      message: `Person ${avi.person_id} is already a member of family ${second} (member ${m.id})`,
    });

    await ok('DELETE', `/families/${second}/members/${m.id}`);
    const back = await ok('POST', `/families/${second}/members`, { person_id: avi.person_id, relationship: 'grandfather' });
    assert.deepEqual([back.id, back.status, back.relationship, back.sort_order], [m.id, 'active', 'grandfather', 0]);
    assert.deepEqual(
      (await audit('family_members', m.id)).slice(-4).map((r) => [r.action, r.col_name, r.old_value, r.new_value]),
      [
        ['delete', 'status', 'active', 'trash'],
        ['update', 'status', 'trash', 'active'],
        ['update', 'relationship', 'uncle', 'grandfather'],
        ['update', 'sort_order', '3', '0'],
      ],
    );
  });

  test("restoring a removed member resets that member's rights for every child, with audit rows", async () => {
    const familyId = await family('Restore');
    const child = await link(familyId);
    const draft = await freeChild();
    const dad = await newMember(familyId, 'Baruch', 'father');
    await ok('PUT', `/people/${dad.person_id}/phones`, {
      phones: [{ phone: '845-555-0177', label: 'mobile', is_primary: true }],
    });
    await ok('PATCH', `/people/${dad.person_id}`, { email: 'baruch@example.test' });
    const linkedRight = await right(dad.id, child, {
      receives_notifications: 1,
      notify_method: 'both',
      may_collect: 1,
      collect_from: '2026-09-01',
      collect_to: '2027-06-30',
      is_emergency: 1,
      is_payment_responsible: 1,
      is_primary: 1,
    });
    const draftRight = await right(dad.id, draft, { receives_notifications: 1 });
    const before = await legacy(child);
    assert.deepEqual([before.use_father, before.parent_email], [1, 'baruch@example.test']);

    await ok('DELETE', `/families/${familyId}/members/${dad.id}`);
    const back = await ok('POST', `/families/${familyId}/members`, { person_id: dad.person_id, relationship: 'father' });
    assert.deepEqual([back.id, back.status], [dad.id, 'active']);

    const [rows] = await admin.query<RowDataPacket[]>(
      `SELECT id, receives_notifications, may_collect, collect_from, collect_to, is_emergency, is_payment_responsible,
              notify_method, is_primary
         FROM family_member_children WHERE member_id = ? ORDER BY id`,
      [dad.id],
    );
    const reset = {
      receives_notifications: 0,
      may_collect: 0,
      collect_from: null,
      collect_to: null,
      is_emergency: 0,
      is_payment_responsible: 0,
    };
    assert.deepEqual(
      rows.map((r) => ({ ...r })),
      [
        { id: linkedRight, ...reset, notify_method: 'both', is_primary: 1 },
        { id: draftRight, ...reset, notify_method: 'sms', is_primary: 0 },
      ],
    );
    assert.deepEqual(
      (await audit('family_member_children', linkedRight)).map((r) => [r.action, r.col_name, r.old_value, r.new_value, r.user_id]),
      [
        ['update', 'receives_notifications', '1', '0', adminId],
        ['update', 'may_collect', '1', '0', adminId],
        ['update', 'collect_from', '2026-09-01', null, adminId],
        ['update', 'collect_to', '2027-06-30', null, adminId],
        ['update', 'is_emergency', '1', '0', adminId],
        ['update', 'is_payment_responsible', '1', '0', adminId],
      ],
    );
    assert.deepEqual(
      (await audit('family_member_children', draftRight)).map((r) => r.col_name),
      ['receives_notifications'],
    );

    const after = await legacy(child);
    assert.deepEqual(
      [after.father_name, after.father_phone, after.use_father, after.parent_email],
      [`Baruch ${MARK}ln`, '845-555-0177', 0, ''],
      'back in the father slot, but no notifications and not payment-responsible until staff set rights again',
    );
    assert.deepEqual(back.warning.affected_child_ids, [child], 'use_father and parent_email changed');
  });

  test('404 for an unknown family or an unknown person_id', async () => {
    assert.equal((await api('POST', `/families/${NO_ID}/members`, { person_id: 1, relationship: 'father' })).statusCode, 404);
    const familyId = await family('Missing');
    const res = await api('POST', `/families/${familyId}/members`, { person_id: NO_ID, relationship: 'father' });
    assert.deepEqual([res.statusCode, res.json().message], [404, `Person ${NO_ID} not found`]);
  });

  test('adding the father of a linked child warns with that child; legacy values are mirrored', async () => {
    const familyId = await family('Linked');
    const child = await link(familyId);
    const m = await newMember(familyId, 'Dov', 'father');
    assert.deepEqual(m.warning.affected_child_ids, [child]);
    assert.match(m.warning.message, /1 linked child$/);
    assert.equal((await legacy(child)).father_name, `Dov ${MARK}ln`);

    const uncle = await newMember(familyId, 'Uri', 'uncle');
    assert.equal(uncle.warning, undefined, 'an uncle fills no legacy slot');
  });
});

describe('PATCH and DELETE /families/:id/members/:memberId', () => {
  test('relationship, is_primary (clears the other primary), sort_order; warning when the father slot changes', async () => {
    const familyId = await family('EditMember');
    const child = await link(familyId);
    const dad = await newMember(familyId, 'Moshe', 'father', { is_primary: true });
    const mom = await newMember(familyId, 'Leah', 'mother');

    const res = await ok('PATCH', `/families/${familyId}/members/${dad.id}`, { relationship: 'uncle', sort_order: 5 });
    assert.deepEqual([res.relationship, res.sort_order, res.person.fname], ['uncle', 5, 'Moshe']);
    assert.deepEqual(res.warning.affected_child_ids, [child]);
    assert.equal((await legacy(child)).father_name, '', 'no father any more');

    const primary = await ok('PATCH', `/families/${familyId}/members/${mom.id}`, { is_primary: true });
    assert.equal(primary.is_primary, true);
    const [rows] = await admin.query<RowDataPacket[]>('SELECT id, is_primary FROM family_members WHERE family_id = ? ORDER BY id', [familyId]);
    assert.deepEqual(rows.map((r) => [r.id, r.is_primary]), [[dad.id, 0], [mom.id, 1]], 'one primary member per family');
    assert.deepEqual((await audit('family_members', dad.id)).at(-1), {
      action: 'update', col_name: 'is_primary', old_value: '1', new_value: '0', user_id: adminId,
    });

    const same = await ok('PATCH', `/families/${familyId}/members/${mom.id}`, { is_primary: true });
    assert.equal(same.warning, undefined);
  });

  test('making a member primary: warning when parent_email changes; an audit row for every member cleared', async () => {
    const familyId = await family('Primary');
    const child = await link(familyId);
    const add = async (fname: string, relationship: string) => {
      const m = await ok(
        'POST',
        `/families/${familyId}/members`,
        { person: { fname, lname: `${MARK}ln`, email: `${fname.toLowerCase()}@example.test` }, relationship },
        201,
      );
      people.push(m.person_id);
      return m;
    };
    const dad = await add('Ari', 'father');
    const mom = await add('Rina', 'mother');
    const gma = await add('Sara', 'grandmother');
    assert.equal((await legacy(child)).parent_email, '', 'no payer and no primary member');

    const first = await ok('PATCH', `/families/${familyId}/members/${dad.id}`, { is_primary: true });
    assert.deepEqual(first.warning.affected_child_ids, [child]);
    assert.equal((await legacy(child)).parent_email, 'ari@example.test');

    // Two primaries already stored (older data could hold them): both are cleared and audited.
    await admin.query('UPDATE family_members SET is_primary = 1 WHERE id = ?', [gma.id]);
    const second = await ok('PATCH', `/families/${familyId}/members/${mom.id}`, { is_primary: true });
    assert.deepEqual(second.warning.affected_child_ids, [child]);
    assert.equal((await legacy(child)).parent_email, 'rina@example.test');
    const [rows] = await admin.query<RowDataPacket[]>(
      'SELECT id, is_primary FROM family_members WHERE family_id = ? ORDER BY id',
      [familyId],
    );
    assert.deepEqual(
      rows.map((r) => [r.id, r.is_primary]),
      [
        [dad.id, 0],
        [mom.id, 1],
        [gma.id, 0],
      ],
    );
    const cleared = { action: 'update', col_name: 'is_primary', old_value: '1', new_value: '0', user_id: adminId };
    for (const id of [dad.id, gma.id]) assert.deepEqual((await audit('family_members', id)).at(-1), cleared);

    // With a payment-responsible member, parent_email does not follow the primary flag: no warning.
    await right(gma.id, child, { is_payment_responsible: 1 });
    assert.equal((await legacy(child)).parent_email, 'sara@example.test');
    const third = await ok('PATCH', `/families/${familyId}/members/${dad.id}`, { is_primary: true });
    assert.equal(third.warning, undefined);
    assert.equal((await legacy(child)).parent_email, 'sara@example.test');
    assert.deepEqual((await audit('family_members', mom.id)).at(-1), cleared);
  });

  test("a trashed member's rights are ignored: mirror slot, notifications, parent_email, preview, detail, search", async () => {
    const familyId = await family('TrashedRights');
    const child = await link(familyId);
    const draft = await freeChild();
    const dad = await newMember(familyId, 'Gedalya', 'father');
    const step = await newMember(familyId, 'Tuvia', 'step_father');
    await ok('PATCH', `/people/${dad.person_id}`, { email: 'gedalya@example.test' });
    await ok('PUT', `/people/${dad.person_id}/phones`, {
      phones: [{ phone: '718-555-0181', label: 'mobile', is_primary: true }],
    });
    await ok('PUT', `/people/${step.person_id}/phones`, {
      phones: [{ phone: '718-555-0182', label: 'mobile', is_primary: true }],
    });
    const dadRight = await right(dad.id, child, { receives_notifications: 1, notify_method: 'sms', is_payment_responsible: 1 });
    await right(dad.id, draft, { receives_notifications: 1 });
    await right(step.id, child, { receives_notifications: 0, notify_method: 'voice' });

    const before = await legacy(child);
    assert.deepEqual(
      [before.father_name, before.father_phone, before.use_father, before.father_method, before.parent_email],
      [`Gedalya ${MARK}ln`, '718-555-0181', 1, 'sms', 'gedalya@example.test'],
    );
    const search = async () =>
      (await api('GET', `/families?q=${encodeURIComponent(`${MARK} TrashedRights`)}`)).json().items[0];
    assert.equal((await search()).child_count, 2);

    const removed = await ok('DELETE', `/families/${familyId}/members/${dad.id}`);
    assert.deepEqual(removed.warning.affected_child_ids, [child]);

    const after = await legacy(child);
    assert.deepEqual(
      [after.father_name, after.father_phone, after.use_father, after.father_method, after.parent_email],
      [`Tuvia ${MARK}ln`, '718-555-0182', 0, 'voice', ''],
      'the step-father fills the slot; the trashed father no longer drives notifications or parent_email',
    );

    const [result] = await admin.query<RowDataPacket[][]>('CALL sp_family_preview(?, ?)', [draft, familyId]);
    const [preview] = result[0];
    assert.deepEqual(
      [preview.father_name, preview.father_phone, (preview.use_father_phone_for_notification as Buffer)[0]],
      [`Tuvia ${MARK}ln`, '718-555-0182', 0],
      'the link preview ignores him too',
    );

    const detail = (await api('GET', `/families/${familyId}`)).json();
    assert.deepEqual(
      detail.members.map((m: { id: number }) => m.id),
      [step.id],
    );
    assert.deepEqual(
      detail.children.map((c: { id: number }) => c.id),
      [child],
      'the draft child had rights only from him',
    );
    assert.ok(!detail.children[0].rights.some((r: { id: number }) => r.id === dadRight));
    const item = await search();
    assert.deepEqual([item.child_count, item.member_count], [1, 1]);
  });

  test('DELETE sets status trash and keeps the row; then 404; a member of another family is 404', async () => {
    const familyId = await family('Remove');
    const other = await family('Other');
    const child = await link(familyId);
    const dad = await newMember(familyId, 'Yosef', 'father');

    assert.equal((await api('PATCH', `/families/${other}/members/${dad.id}`, { sort_order: 1 })).statusCode, 404);
    const removed = await ok('DELETE', `/families/${familyId}/members/${dad.id}`);
    assert.equal(removed.status, 'trash');
    assert.deepEqual(removed.warning.affected_child_ids, [child]);
    const [[row]] = await admin.query<RowDataPacket[]>('SELECT status FROM family_members WHERE id = ?', [dad.id]);
    assert.equal(row.status, 'trash', 'never a hard delete');
    assert.equal((await legacy(child)).father_name, '');

    const again = await api('DELETE', `/families/${familyId}/members/${dad.id}`);
    assert.deepEqual([again.statusCode, again.json().message], [404, `Member ${dad.id} of family ${familyId} not found`]);
    assert.equal((await api('PATCH', `/families/${familyId}/members/${dad.id}`, { sort_order: 1 })).statusCode, 404);
  });
});

describe('PATCH /people/:id', () => {
  test('a note is not mirrored (no warning); a fname change sets legacy_full_name, so father_name changes', async () => {
    const familyId = await family('Person');
    const child = await link(familyId);
    const dad = await newMember(familyId, 'Avraham', 'father');

    const note = await ok('PATCH', `/people/${dad.person_id}`, { note: 'Prefers calls' });
    assert.equal(note.note, 'Prefers calls');
    assert.equal(note.warning, undefined);

    assert.equal((await legacy(child)).father_name, `Avraham ${MARK}ln`);
    const renamed = await ok('PATCH', `/people/${dad.person_id}`, { fname: ' Avi ' });
    assert.deepEqual([renamed.fname, renamed.legacy_full_name], [' Avi ', `Avi ${MARK}ln`], 'parts trimmed, one space');
    assert.deepEqual(renamed.warning.affected_child_ids, [child]);
    assert.deepEqual([(await legacy(child)).father_fname, (await legacy(child)).father_name], [' Avi ', `Avi ${MARK}ln`]);

    const reset = await ok('PATCH', `/people/${dad.person_id}`, { reset_legacy_full_name: true });
    assert.equal(reset.legacy_full_name, `Avi ${MARK}ln`);
    assert.equal(reset.warning, undefined, 'already "fname lname"');

    const [[row]] = await admin.query<RowDataPacket[]>('SELECT updated_by FROM people WHERE id = ?', [dad.person_id]);
    assert.equal(row.updated_by, adminId);
    assert.deepEqual(
      (await audit('people', dad.person_id)).filter((r) => r.action === 'update').map((r) => [r.col_name, r.old_value, r.new_value]),
      [
        ['note', null, 'Prefers calls'],
        ['fname', 'Avraham', ' Avi '],
        ['legacy_full_name', `Avraham ${MARK}ln`, `Avi ${MARK}ln`],
      ],
    );
  });

  test('legacy_full_name is kept unless fname or lname actually changes; an empty part leaves no stray space', async () => {
    const familyId = await family('KeepLegacy');
    const child = await link(familyId);
    const dad = await newMember(familyId, 'Zalman', 'father');
    await admin.query("UPDATE people SET legacy_full_name = 'Zalman Sr.' WHERE id = ?", [dad.person_id]); // as backfilled
    assert.equal((await legacy(child)).father_name, 'Zalman Sr.');

    const same = await ok('PATCH', `/people/${dad.person_id}`, {
      fname: 'Zalman',
      lname: `${MARK}ln`,
      email: 'z@example.test',
    });
    assert.equal(same.legacy_full_name, 'Zalman Sr.', 'the same fname / lname is no change');
    assert.equal((await legacy(child)).father_name, 'Zalman Sr.');

    const onlyFirst = await ok('PATCH', `/people/${dad.person_id}`, { lname: '' });
    assert.equal(onlyFirst.legacy_full_name, 'Zalman');
    assert.equal((await legacy(child)).father_name, 'Zalman');
    assert.deepEqual(
      (await audit('people', dad.person_id))
        .filter((r) => r.action === 'update')
        .map((r) => [r.col_name, r.old_value, r.new_value]),
      [
        ['email', '', 'z@example.test'],
        ['lname', `${MARK}ln`, ''],
        ['legacy_full_name', 'Zalman Sr.', 'Zalman'],
      ],
    );
  });

  test('a rename making "fname lname" over 100 characters -> 400; unknown or trashed person -> 404', async () => {
    const familyId = await family('LongName');
    const p = await newMember(familyId, 'Short', 'other');
    const res = await api('PATCH', `/people/${p.person_id}`, { fname: 'a'.repeat(100) });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().message, /fname \/ lname: legacy_full_name becomes "fname lname".*varchar\(100\)/);
    const [[row]] = await admin.query<RowDataPacket[]>('SELECT fname FROM people WHERE id = ?', [p.person_id]);
    assert.equal(row.fname, 'Short', 'the whole edit was rolled back');

    assert.equal((await api('PATCH', `/people/${NO_ID}`, { note: 'x' })).statusCode, 404);
    await admin.query("UPDATE people SET status = 'trash' WHERE id = ?", [p.person_id]);
    assert.equal((await api('PATCH', `/people/${p.person_id}`, { note: 'x' })).statusCode, 404);
  });

  test("a person in two families: the warning lists linked children of both", async () => {
    const one = await family('TwoA');
    const two = await family('TwoB');
    const childOne = await link(one);
    const childTwo = await link(two);
    const dad = await newMember(one, 'Shlomo', 'father');
    await ok('POST', `/families/${two}/members`, { person_id: dad.person_id, relationship: 'father' }, 201);

    const res = await ok('PATCH', `/people/${dad.person_id}`, { email: 'shlomo@example.test' });
    assert.deepEqual(res.warning.affected_child_ids, [childOne, childTwo].sort((a, b) => a - b));
    assert.equal((await legacy(childTwo)).father_email, 'shlomo@example.test');
  });
});

describe('PUT /people/:id/phones and /addresses', () => {
  test('phones: the full list replaced in one transaction, phone_normalized computed, father_phone mirrored', async () => {
    const familyId = await family('Phones');
    const child = await link(familyId);
    const dad = await newMember(familyId, 'Chaim', 'father');

    const phones = [
      { phone: '(718) 555-0123 x4', label: 'mobile', is_primary: true },
      { phone: '718.555.0124', label: 'home', channel: 'voice' },
    ];
    const res = await ok('PUT', `/people/${dad.person_id}/phones`, { phones });
    assert.deepEqual(
      res.phones.map((p: Record<string, unknown>) => [p.phone, p.phone_normalized, p.label, p.channel, p.is_primary, p.sort_order]),
      [
        ['(718) 555-0123 x4', '7185550123', 'mobile', 'sms', true, 0],
        ['718.555.0124', '7185550124', 'home', 'voice', false, 1],
      ],
    );
    assert.deepEqual(res.warning.affected_child_ids, [child]);
    assert.equal((await legacy(child)).father_phone, '(718) 555-0123 x4');

    const ids = res.phones.map((p: { id: number }) => p.id);
    const same = await ok('PUT', `/people/${dad.person_id}/phones`, { phones });
    assert.equal(same.warning, undefined, 'the same list changes nothing');
    assert.deepEqual(same.phones.map((p: { id: number }) => p.id), ids);

    const phoneAudit = (await audit('people', dad.person_id)).filter((r) => r.col_name === 'phones');
    assert.equal(phoneAudit.length, 1, 'one audit row per actual change');
    assert.equal(JSON.parse(phoneAudit[0].new_value).length, 2);

    const cleared = await ok('PUT', `/people/${dad.person_id}/phones`, { phones: [] });
    assert.deepEqual(cleared.phones, []);
    assert.equal((await legacy(child)).father_phone, '');

    const bad = await api('PUT', `/people/${dad.person_id}/phones`, { phones: [{ phone: '1', label: 'mobile' }] });
    assert.equal(bad.statusCode, 400, 'exactly one primary');
  });

  test('addresses: a home address is mirrored (warning); a billing address is not (no warning)', async () => {
    const familyId = await family('Addresses');
    const child = await link(familyId);
    const dad = await newMember(familyId, 'Eli', 'father');

    const billing = await ok('PUT', `/people/${dad.person_id}/addresses`, { addresses: [{ kind: 'billing', line1: '1 Pay St' }] });
    assert.deepEqual(billing.addresses.map((a: { kind: string; line1: string; city: string }) => [a.kind, a.line1, a.city]), [['billing', '1 Pay St', '']]);
    assert.equal(billing.warning, undefined);

    const home = await ok('PUT', `/people/${dad.person_id}/addresses`, {
      addresses: [{ kind: 'home', line1: '12 Elm St', city: 'Monsey', state: 'NY', zip: '10952' }],
    });
    assert.deepEqual(home.warning.affected_child_ids, [child]);
    assert.equal((await legacy(child)).father_address, '12 Elm St, Monsey, NY 10952');

    const [[row]] = await admin.query<RowDataPacket[]>('SELECT updated_by FROM people WHERE id = ?', [dad.person_id]);
    assert.equal(row.updated_by, adminId);
    assert.equal((await api('PUT', `/people/${NO_ID}/addresses`, { addresses: [] })).statusCode, 404);
  });
});
