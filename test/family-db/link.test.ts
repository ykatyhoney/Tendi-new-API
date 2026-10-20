// Step 3.6 through the app against tendi_family_test: rights per child, the link preview, link and
// unlink. The app commits its writes, so every row created here is removed in after(); family
// names and surnames start with a run-specific marker. Linking children happens in this database
// only (backend CLAUDE.md rule 7).

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import type { Connection, RowDataPacket } from 'mysql2/promise';
import { buildApp, type App } from '../../src/app.ts';
import { loadConfig } from '../../src/config.ts';
import { connectLocal, loadEnv, requireEnv } from '../../scripts/family/lib/db.ts';

const MARK = `Zl${randomBytes(3).toString('hex')}`;
const NO_ID = 2147483647;
let admin: Connection;
let app: App;
let adminId = 0;
const token = randomBytes(24).toString('hex');
const touchedChildren: number[] = [];
const people: number[] = [];

const api = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object) =>
  app.inject({ method, url, payload, headers: { authorization: `Bearer ${token}` } });

async function ok(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object, status = 200) {
  const res = await api(method, url, payload);
  assert.equal(res.statusCode, status, `${method} ${url}: ${res.body}`);
  return res.json();
}

async function fails(method: 'GET' | 'POST' | 'PUT', url: string, status: number, payload?: object) {
  const res = await api(method, url, payload);
  assert.equal(res.statusCode, status, `${method} ${url}: ${res.body}`);
  return res.json().message as string;
}

async function family(name: string, householdPhone = '718-555-0300'): Promise<number> {
  return (await ok('POST', '/families', { name: `${MARK} ${name}`, household_phone: householdPhone }, 201)).id;
}

async function member(familyId: number, fname: string, relationship: string, extra: object = {}) {
  const body = await ok('POST', `/families/${familyId}/members`, { person: { fname, lname: `${MARK}ln` }, relationship, ...extra }, 201);
  people.push(body.person_id);
  return body as { id: number; person_id: number };
}

const phone = (personId: number, number: string) =>
  ok('PUT', `/people/${personId}/phones`, { phones: [{ phone: number, label: 'mobile', is_primary: true }] });

/** A free (unlinked) active child with a children_additional_information row, a different one per call. */
async function freeChild(): Promise<number> {
  const [[row]] = await admin.query<RowDataPacket[]>(
    `SELECT c.id FROM children c JOIN children_additional_information cai ON cai.child_id = c.id
      WHERE c.status = 'active' AND c.family_id IS NULL ORDER BY c.id DESC LIMIT 1 OFFSET ?`,
    [picked++],
  );
  touchedChildren.push(row.id);
  return row.id;
}
let picked = 0;

async function stored(childId: number) {
  const [[row]] = await admin.query<RowDataPacket[]>(
    `SELECT c.family_id, c.father_name, c.mother_name, c.father_phone, c.parent_email,
            c.use_father_phone_for_notification + 0 AS use_father, c.notification_father_phone_method AS father_method,
            cai.father_fname
       FROM children c LEFT JOIN children_additional_information cai ON cai.child_id = c.id WHERE c.id = ?`,
    [childId],
  );
  return { ...row };
}

async function audit(table: string, id: number) {
  const [rows] = await admin.query<RowDataPacket[]>(
    `SELECT action, col_name, old_value, new_value, user_id FROM audit_logs
      WHERE actor_ref = 'family-api' AND table_name = ? AND table_id = ? ORDER BY id`,
    [table, id],
  );
  return rows.map((r) => ({ ...r }));
}

type Column = { column: string; table: string; mirrored: boolean; current: unknown; after_link: unknown; changed: boolean };
const col = (preview: { columns: Column[] }, name: string) => preview.columns.find((c) => c.column === name)!;
const codes = (preview: { warnings: { code: string }[] }) => preview.warnings.map((w) => w.code);

/** A family with a father (primary phone, notifications by sms, pays) and rights for the child. */
async function readyFamily(name: string, childId: number) {
  const familyId = await family(name);
  const father = await member(familyId, 'Avi', 'father', { is_primary: true });
  await phone(father.person_id, '347-555-0101');
  await ok('PUT', `/families/${familyId}/children/${childId}/rights`, {
    rights: [{ member_id: father.id, receives_notifications: true, notify_method: 'sms', is_payment_responsible: true }],
  });
  return { familyId, father };
}

before(async () => {
  loadEnv();
  const database = requireEnv('DB_TEST_NAME');
  admin = await connectLocal(database);
  const [[a]] = await admin.query<RowDataPacket[]>("SELECT id FROM admin WHERE type = 'office' AND status = 'active' LIMIT 1");
  adminId = a.id;
  await admin.query(
    `INSERT INTO admin_api_tokens (admin_id, token_hash, device_id, created_at, last_seen_at)
     VALUES (?, MD5(?), 'family-link-test', NOW(), NOW())`,
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
  const [fams] = await admin.query<RowDataPacket[]>('SELECT id FROM families WHERE name LIKE ?', [`${MARK}%`]);
  const familyIds = fams.map((f) => f.id);
  const [pp] = await admin.query<RowDataPacket[]>('SELECT id FROM people WHERE lname LIKE ?', [`${MARK}%`]);
  const personIds = [...new Set([...people, ...pp.map((p) => p.id)])];
  if (familyIds.length) {
    const [members] = await admin.query<RowDataPacket[]>('SELECT id FROM family_members WHERE family_id IN (?)', [familyIds]);
    const memberIds = members.map((m) => m.id);
    if (memberIds.length) {
      await admin.query(
        `DELETE FROM audit_logs WHERE actor_ref = 'family-api' AND table_name = 'family_member_children'
            AND entity_name LIKE ?`,
        [`Family ${MARK}%`],
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
  await admin.query("DELETE FROM admin_api_tokens WHERE device_id = 'family-link-test'");
  await admin.end();
});

describe('PUT /families/:id/children/:childId/rights', () => {
  test('inserts, updates and deletes rows (uniq_fmc), with an audit row per changed column', async () => {
    const childId = await freeChild();
    const familyId = await family('Rights');
    const avi = await member(familyId, 'Avi', 'father');
    const sara = await member(familyId, 'Sara', 'mother', { sort_order: 1 });
    const url = `/families/${familyId}/children/${childId}/rights`;

    const first = await ok('PUT', url, {
      rights: [
        { member_id: sara.id, may_collect: true, collect_from: '2026-09-01', collect_to: '2027-06-30' },
        { member_id: avi.id, receives_notifications: true, notify_method: 'both' },
      ],
    });
    assert.equal(first.warning, undefined, 'the child is not linked: no mirror warning');
    assert.deepEqual(
      first.rights.map((r: Record<string, unknown>) => [r.member_id, r.receives_notifications, r.notify_method, r.may_collect, r.collect_from, r.collect_to]),
      [
        [avi.id, true, 'both', false, null, null],
        [sara.id, false, 'sms', true, '2026-09-01', '2027-06-30'],
      ],
      'ordered by member sort_order',
    );
    const aviRow = first.rights[0].id;
    const saraRow = first.rights[1].id;
    assert.deepEqual(
      (await audit('family_member_children', aviRow)).map((r) => [r.action, r.col_name, r.new_value, r.user_id]),
      [
        ['insert', 'member_id', String(avi.id), adminId],
        ['insert', 'child_id', String(childId), adminId],
        ['insert', 'is_primary', '0', adminId],
        ['insert', 'receives_notifications', '1', adminId],
        ['insert', 'notify_method', 'both', adminId],
        ['insert', 'may_collect', '0', adminId],
        ['insert', 'is_emergency', '0', adminId],
        ['insert', 'is_payment_responsible', '0', adminId],
      ],
    );

    // Same list again: nothing changes, no audit row.
    await ok('PUT', url, {
      rights: [
        { member_id: sara.id, may_collect: true, collect_from: '2026-09-01', collect_to: '2027-06-30' },
        { member_id: avi.id, receives_notifications: true, notify_method: 'both' },
      ],
    });
    assert.equal((await audit('family_member_children', aviRow)).length, 8);

    // Avi only, now payment-responsible: Avi's row is updated in place, Sara's deleted.
    const second = await ok('PUT', url, { rights: [{ member_id: avi.id, receives_notifications: true, notify_method: 'both', is_payment_responsible: true }] });
    assert.deepEqual(second.rights.map((r: { id: number }) => r.id), [aviRow]);
    assert.deepEqual(
      (await audit('family_member_children', aviRow)).slice(8).map((r) => [r.action, r.col_name, r.old_value, r.new_value]),
      [['update', 'is_payment_responsible', '0', '1']],
    );
    assert.deepEqual(
      (await audit('family_member_children', saraRow)).slice(10).map((r) => [r.action, r.col_name, r.old_value, r.new_value]),
      [
        ['delete', 'member_id', String(sara.id), null],
        ['delete', 'is_primary', '0', null],
        ['delete', 'receives_notifications', '0', null],
        ['delete', 'notify_method', 'sms', null],
        ['delete', 'may_collect', '1', null],
        ['delete', 'collect_from', '2026-09-01', null],
        ['delete', 'collect_to', '2027-06-30', null],
        ['delete', 'is_emergency', '0', null],
        ['delete', 'is_payment_responsible', '0', null],
      ],
    );
    const [[left]] = await admin.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM family_member_children WHERE id = ?', [saraRow]);
    assert.equal(left.n, 0);
  });

  test("members must be active members of this family (409); a removed member's rows are kept", async () => {
    const childId = await freeChild();
    const familyId = await family('RightsCheck');
    const other = await family('RightsOther');
    const avi = await member(familyId, 'Avi', 'father');
    const dov = await member(familyId, 'Dov', 'uncle');
    const stranger = await member(other, 'Eli', 'father');
    const url = `/families/${familyId}/children/${childId}/rights`;

    const message = await fails('PUT', url, 409, { rights: [{ member_id: avi.id }, { member_id: stranger.id }] });
    assert.equal(message, `rights/1/member_id: ${stranger.id} is not an active member of family ${familyId}`);
    const [[none]] = await admin.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM family_member_children WHERE child_id = ? AND member_id = ?', [childId, avi.id]);
    assert.equal(none.n, 0, 'the whole request was rolled back');

    await ok('PUT', url, { rights: [{ member_id: avi.id }, { member_id: dov.id, may_collect: true }] });
    await ok('DELETE', `/families/${familyId}/members/${dov.id}`);
    assert.match(await fails('PUT', url, 409, { rights: [{ member_id: dov.id }] }), /is not an active member/);

    const res = await ok('PUT', url, { rights: [{ member_id: avi.id, is_emergency: true }] });
    assert.deepEqual(res.rights.map((r: { member_id: number }) => r.member_id), [avi.id]);
    const [[kept]] = await admin.query<RowDataPacket[]>('SELECT may_collect FROM family_member_children WHERE child_id = ? AND member_id = ?', [childId, dov.id]);
    assert.equal(kept.may_collect, 1, "the removed member's row stays as it was");
  });

  test('404 for an unknown family or child; 400 for a member listed twice', async () => {
    const childId = await freeChild();
    const familyId = await family('Rights404');
    const avi = await member(familyId, 'Avi', 'father');
    assert.equal(await fails('PUT', `/families/${NO_ID}/children/${childId}/rights`, 404, { rights: [] }), `Family ${NO_ID} not found`);
    assert.equal(await fails('PUT', `/families/${familyId}/children/${NO_ID}/rights`, 404, { rights: [] }), `Child ${NO_ID} not found`);
    assert.match(await fails('PUT', `/families/${familyId}/children/${childId}/rights`, 400, { rights: [{ member_id: avi.id }, { member_id: avi.id }] }), /more than once/);
  });
});

describe('GET /families/:id/children/:childId/preview', () => {
  test('29 columns now and after linking; home_send_notification is shown but not mirrored', async () => {
    const childId = await freeChild();
    const { familyId } = await readyFamily('Preview', childId);
    const before = await stored(childId);
    const preview = await ok('GET', `/families/${familyId}/children/${childId}/preview`);

    assert.deepEqual([preview.child_id, preview.family_id, preview.linked_family_id], [childId, familyId, null]);
    assert.equal(preview.columns.length, 29);
    assert.equal(preview.columns.filter((c: Column) => c.table === 'children').length, 11);
    assert.equal(preview.columns.filter((c: Column) => c.table === 'children_additional_information').length, 18);
    const hsn = col(preview, 'home_send_notification');
    assert.deepEqual([hsn.mirrored, hsn.changed, hsn.after_link === hsn.current], [false, false, true]);

    assert.deepEqual(
      ['father_name', 'father_phone', 'home_phone', 'use_father_phone_for_notification', 'notification_father_phone_method', 'mother_name', 'father_fname'].map(
        (c) => col(preview, c).after_link,
      ),
      [`Avi ${MARK}ln`, '347-555-0101', '718-555-0300', 1, 'sms', '', 'Avi'],
    );
    assert.equal(col(preview, 'father_name').current, before.father_name);
    for (const c of preview.columns as Column[]) assert.equal(c.changed, c.current !== c.after_link, c.column);
    assert.deepEqual(codes(preview), ['no_mother']);
    assert.deepEqual(await stored(childId), before, 'the preview writes nothing');
  });

  test('warnings: no rights, no father, no primary phone, nobody payment-responsible, linked elsewhere', async () => {
    const childId = await freeChild();
    const empty = await family('PreviewEmpty');
    assert.deepEqual(codes(await ok('GET', `/families/${empty}/children/${childId}/preview`)), [
      'no_rights',
      'no_father',
      'no_mother',
      'no_payment_responsible',
    ]);

    const familyId = await family('PreviewWarn');
    const sara = await member(familyId, 'Sara', 'step_mother');
    await ok('PUT', `/families/${familyId}/children/${childId}/rights`, { rights: [{ member_id: sara.id }] });
    const preview = await ok('GET', `/families/${familyId}/children/${childId}/preview`);
    assert.deepEqual(codes(preview), ['no_father', 'no_primary_phone', 'no_payment_responsible']);
    assert.equal(preview.warnings[1].message, `The mother (Sara ${MARK}ln) has no primary phone: mother_phone will be empty`);

    const { familyId: home } = await readyFamily('PreviewHome', childId);
    await ok('POST', `/families/${home}/children/${childId}/link`);
    const elsewhere = await ok('GET', `/families/${familyId}/children/${childId}/preview`);
    assert.equal(elsewhere.linked_family_id, home);
    assert.equal(codes(elsewhere)[0], 'linked_to_other_family');
    assert.ok(!codes(await ok('GET', `/families/${home}/children/${childId}/preview`)).includes('linked_to_other_family'));
  });

  test('404 for an unknown family or child', async () => {
    const childId = await freeChild();
    const familyId = await family('Preview404');
    assert.equal(await fails('GET', `/families/${NO_ID}/children/${childId}/preview`, 404), `Family ${NO_ID} not found`);
    assert.equal(await fails('GET', `/families/${familyId}/children/${NO_ID}/preview`, 404), `Child ${NO_ID} not found`);
  });
});

describe('POST /families/:id/children/:childId/link and /children/:childId/unlink', () => {
  test('link: the mirror writes what the preview showed; the fresh preview shows no change; audited', async () => {
    const childId = await freeChild();
    const { familyId } = await readyFamily('Link', childId);
    const preview = await ok('GET', `/families/${familyId}/children/${childId}/preview`);

    const linked = await ok('POST', `/families/${familyId}/children/${childId}/link`);
    assert.equal(linked.linked_family_id, familyId);
    assert.deepEqual(linked.columns.filter((c: Column) => c.changed).map((c: Column) => c.column), []);
    assert.deepEqual(
      linked.columns.map((c: Column) => [c.column, c.current]),
      preview.columns.map((c: Column) => [c.column, c.after_link]),
      'the stored values are the ones the preview announced',
    );
    const now = await stored(childId);
    assert.deepEqual(
      [now.family_id, now.father_name, now.father_phone, now.use_father, now.father_method, now.father_fname],
      [familyId, `Avi ${MARK}ln`, '347-555-0101', 1, 'sms', 'Avi'],
    );
    assert.deepEqual(
      (await audit('children', childId)).map((r) => [r.action, r.col_name, r.old_value, r.new_value, r.user_id]),
      [['link', 'family_id', null, String(familyId), adminId]],
    );
    assert.equal(await fails('POST', `/families/${familyId}/children/${childId}/link`, 409), `Child ${childId} is already linked to family ${familyId}`);
  });

  test('rights change on a linked child: the mirror rewrites it and the response warns', async () => {
    const childId = await freeChild();
    const { familyId, father } = await readyFamily('LinkedRights', childId);
    await ok('POST', `/families/${familyId}/children/${childId}/link`);
    const res = await ok('PUT', `/families/${familyId}/children/${childId}/rights`, {
      rights: [{ member_id: father.id, receives_notifications: false, notify_method: 'voice', is_payment_responsible: true }],
    });
    assert.deepEqual(res.warning.affected_child_ids, [childId]);
    const now = await stored(childId);
    assert.deepEqual([now.use_father, now.father_method], [0, 'voice']);
  });

  test('link needs rights rows (409), and force=move to leave another family', async () => {
    const childId = await freeChild();
    const bare = await family('LinkBare');
    await member(bare, 'Avi', 'father');
    assert.match(await fails('POST', `/families/${bare}/children/${childId}/link`, 409), /has no rights rows in family/);
    assert.equal((await stored(childId)).family_id, null);

    const { familyId: first } = await readyFamily('LinkFirst', childId);
    const { familyId: second } = await readyFamily('LinkSecond', childId);
    await ok('POST', `/families/${first}/children/${childId}/link`);
    assert.equal(
      await fails('POST', `/families/${second}/children/${childId}/link`, 409),
      `Child ${childId} is linked to family ${first}; send force=move to move it to family ${second}`,
    );
    assert.equal((await api('POST', `/families/${second}/children/${childId}/link?force=yes`)).statusCode, 400);
    const moved = await ok('POST', `/families/${second}/children/${childId}/link?force=move`);
    assert.equal(moved.linked_family_id, second);
    assert.equal((await stored(childId)).family_id, second);
    assert.deepEqual(
      (await audit('children', childId)).map((r) => [r.action, r.old_value, r.new_value]),
      [
        ['link', null, String(first)],
        ['link', String(first), String(second)],
      ],
    );
  });

  test('unlink: family_id back to NULL, every value stays; 409 when not linked; 404 unknown child', async () => {
    const childId = await freeChild();
    const { familyId } = await readyFamily('Unlink', childId);
    await ok('POST', `/families/${familyId}/children/${childId}/link`);
    const linked = await stored(childId);

    assert.deepEqual(await ok('POST', `/children/${childId}/unlink`), { child_id: childId, family_id: null });
    assert.deepEqual(await stored(childId), { ...linked, family_id: null });
    assert.deepEqual(
      (await audit('children', childId)).map((r) => [r.action, r.old_value, r.new_value]).at(-1),
      ['unlink', String(familyId), null],
    );
    assert.equal(await fails('POST', `/children/${childId}/unlink`, 409), `Child ${childId} is not linked to a family`);
    assert.equal(await fails('POST', `/children/${NO_ID}/unlink`, 404), `Child ${NO_ID} not found`);

    // The child form owns the columns again: a legacy write saves.
    await admin.query("UPDATE children SET father_phone = '347-555-0199' WHERE id = ?", [childId]);
    assert.equal((await stored(childId)).father_phone, '347-555-0199');
  });

  test('a child without a children_additional_information row: current is null, linking creates the row (D4)', async () => {
    const [[row]] = await admin.query<RowDataPacket[]>(
      `SELECT c.id FROM children c LEFT JOIN children_additional_information cai ON cai.child_id = c.id
        WHERE cai.child_id IS NULL AND c.family_id IS NULL ORDER BY c.id LIMIT 1`,
    );
    const childId: number = row.id;
    touchedChildren.push(childId);
    const { familyId } = await readyFamily('NoCai', childId);
    const preview = await ok('GET', `/families/${familyId}/children/${childId}/preview`);
    assert.deepEqual(
      preview.columns.filter((c: Column) => c.table === 'children_additional_information').map((c: Column) => c.current),
      Array(18).fill(null),
    );
    assert.deepEqual([col(preview, 'father_fname').after_link, col(preview, 'father_fname').changed], ['Avi', true]);

    const linked = await ok('POST', `/families/${familyId}/children/${childId}/link`);
    assert.deepEqual(linked.columns.filter((c: Column) => c.changed), []);
    assert.equal((await stored(childId)).father_fname, 'Avi');

    await ok('POST', `/children/${childId}/unlink`);
    await admin.query('DELETE FROM children_additional_information WHERE child_id = ?', [childId]); // keep the dump's 4 missing rows
  });

  test('a mirror SIGNAL (value too long for its legacy column) is a 409, and nothing is linked', async () => {
    const childId = await freeChild();
    const { familyId, father } = await readyFamily('Signal', childId);
    // The API refuses such an email (150 max); written directly, as an old row could hold it.
    await admin.query('UPDATE people SET email = ? WHERE id = ?', [`${'a'.repeat(145)}@x.test`, father.person_id]);
    const expected = `Family value too long for children_additional_information.father_email (150), child ${childId}`;
    assert.equal(await fails('GET', `/families/${familyId}/children/${childId}/preview`, 409), expected);
    assert.equal(await fails('POST', `/families/${familyId}/children/${childId}/link`, 409), expected);
    assert.equal((await stored(childId)).family_id, null);
    assert.deepEqual(await audit('children', childId), []);
  });
});
