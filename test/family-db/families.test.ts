// Step 3.4 through the app against tendi_family_test: GET /families (search), POST /families,
// GET /families/:id, PATCH /families/:id. The app commits its writes, so every row created here
// is removed in after(); names start with a run-specific marker.

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import type { Connection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { buildApp, type App } from '../../src/app.ts';
import { loadConfig } from '../../src/config.ts';
import { connectLocal, loadEnv, requireEnv } from '../../scripts/family/lib/db.ts';

const MARK = `Zq${randomBytes(3).toString('hex')}`; // unique family-name prefix for this run
let admin: Connection;
let app: App;
let adminId = 0;
const token = randomBytes(24).toString('hex');
const linkedChildren: number[] = [];

const api = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) =>
  app.inject({ method, url, payload, headers: { authorization: `Bearer ${token}` } });

async function insert(sql: string, params: unknown[]): Promise<number> {
  const [r] = await admin.query<ResultSetHeader>(sql, params);
  return r.insertId;
}

async function person(fname: string, lname: string, legacy = `${fname} ${lname}`, status = 'active') {
  return insert(
    `INSERT INTO people (fname, lname, legacy_full_name, email, status, created_at, updated_at, created_by, updated_by)
     VALUES (?, ?, ?, ?, ?, NOW(), NOW(), 0, 0)`,
    [fname, lname, legacy, `${fname.toLowerCase()}@example.test`, status],
  );
}

const member = (familyId: number, personId: number, relationship: string, extra: { sort?: number; status?: string } = {}) =>
  insert(
    'INSERT INTO family_members (family_id, person_id, relationship, is_primary, sort_order, status) VALUES (?, ?, ?, ?, ?, ?)',
    [familyId, personId, relationship, extra.sort === 0 ? 1 : 0, extra.sort ?? 0, extra.status ?? 'active'],
  );

async function freeChildren(n: number): Promise<number[]> {
  const [rows] = await admin.query<RowDataPacket[]>(
    `SELECT c.id FROM children c JOIN children_additional_information cai ON cai.child_id = c.id
      WHERE c.status = 'active' AND c.family_id IS NULL ORDER BY c.id DESC LIMIT ?`,
    [n],
  );
  return rows.map((r) => r.id);
}

before(async () => {
  loadEnv();
  const database = requireEnv('DB_TEST_NAME');
  admin = await connectLocal(database);
  const [[a]] = await admin.query<RowDataPacket[]>("SELECT id FROM admin WHERE type = 'office' AND status = 'active' LIMIT 1");
  adminId = a.id;
  await admin.query(
    `INSERT INTO admin_api_tokens (admin_id, token_hash, device_id, created_at, last_seen_at)
     VALUES (?, MD5(?), 'family-families-test', NOW(), NOW())`,
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
  if (familyIds.length) {
    const [pp] = await admin.query<RowDataPacket[]>('SELECT DISTINCT person_id FROM family_members WHERE family_id IN (?)', [familyIds]);
    const personIds = pp.map((p) => p.person_id);
    await admin.query(
      'DELETE fmc FROM family_member_children fmc JOIN family_members fm ON fm.id = fmc.member_id WHERE fm.family_id IN (?)',
      [familyIds],
    );
    await admin.query('DELETE FROM family_members WHERE family_id IN (?)', [familyIds]);
    if (personIds.length) await admin.query('DELETE FROM people WHERE id IN (?)', [personIds]);
    await admin.query("DELETE FROM audit_logs WHERE actor_ref = 'family-api' AND table_name = 'families' AND table_id IN (?)", [familyIds]);
    await admin.query('DELETE FROM families WHERE id IN (?)', [familyIds]);
  }
  await admin.query("DELETE FROM admin_api_tokens WHERE device_id = 'family-families-test'");
  await admin.end();
});

describe('POST /families', () => {
  test('creates the household with created_by / updated_by and timestamps, and audit_logs rows', async () => {
    const res = await api('POST', '/families', { name: `${MARK} Katz`, household_phone: '(718) 555-0199' });
    assert.equal(res.statusCode, 201);
    const body = res.json();
    assert.equal(body.name, `${MARK} Katz`);
    assert.equal(body.household_phone, '(718) 555-0199');
    assert.deepEqual([body.status, body.members, body.children], ['active', [], []]);
    assert.match(body.created_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

    const [[row]] = await admin.query<RowDataPacket[]>(
      'SELECT created_by, updated_by, household_phone_normalized, created_at > NOW() - INTERVAL 1 MINUTE AS fresh FROM families WHERE id = ?',
      [body.id],
    );
    assert.deepEqual({ ...row }, { created_by: adminId, updated_by: adminId, household_phone_normalized: '7185550199', fresh: 1 });

    const [audit] = await admin.query<RowDataPacket[]>(
      "SELECT action, col_name, old_value, new_value, user_id, actor_type FROM audit_logs WHERE table_name = 'families' AND table_id = ? ORDER BY id",
      [body.id],
    );
    assert.deepEqual(
      audit.map((r) => ({ ...r })),
      [
        { action: 'insert', col_name: 'name', old_value: null, new_value: `${MARK} Katz`, user_id: adminId, actor_type: 'admin' },
        { action: 'insert', col_name: 'household_phone', old_value: null, new_value: '(718) 555-0199', user_id: adminId, actor_type: 'admin' },
      ],
    );
  });

  test('household_phone defaults to empty', async () => {
    const res = await api('POST', '/families', { name: `${MARK} NoPhone` });
    assert.equal(res.statusCode, 201);
    assert.equal(res.json().household_phone, '');
  });
});

describe('GET /families/:id', () => {
  test('members with person, phones and addresses; linked children and children with rights; rights rows', async () => {
    const familyId = (await api('POST', '/families', { name: `${MARK} Detail`, household_phone: '718-555-0101' })).json().id;
    const father = await person('Avi', `${MARK}Detail`, 'Avi Detail');
    const grandma = await person('Rivka', `${MARK}Detail`, '');
    await insert("INSERT INTO people_phones (person_id, phone, phone_normalized, label, is_primary) VALUES (?, '347-555-0177', '3475550177', 'mobile', 1)", [father]);
    await insert("INSERT INTO people_addresses (person_id, kind, line1, city) VALUES (?, 'home', '12 Elm St', 'Monsey')", [father]);
    const fm = await member(familyId, father, 'father', { sort: 0 });
    const gm = await member(familyId, grandma, 'grandmother', { sort: 1 });
    await member(familyId, await person('Gone', `${MARK}Detail`), 'uncle', { sort: 2, status: 'trash' });
    const [draftChild, linkedChild] = await freeChildren(2);
    await insert("INSERT INTO family_member_children (member_id, child_id, receives_notifications, notify_method, may_collect, collect_from, collect_to) VALUES (?, ?, 1, 'sms', 1, '2026-09-01', '2027-06-30')", [fm, draftChild]);
    await insert("INSERT INTO family_member_children (member_id, child_id, is_payment_responsible) VALUES (?, ?, 1)", [gm, linkedChild]);
    await admin.query('UPDATE children SET family_id = ? WHERE id = ?', [familyId, linkedChild]);
    linkedChildren.push(linkedChild);

    const res = await api('GET', `/families/${familyId}`);
    assert.equal(res.statusCode, 200);
    const f = res.json();
    assert.deepEqual(f.members.map((m: { relationship: string; sort_order: number; is_primary: boolean }) => [m.relationship, m.sort_order, m.is_primary]), [
      ['father', 0, true],
      ['grandmother', 1, false],
    ], 'trashed members are left out');
    const avi = f.members[0].person;
    assert.deepEqual([avi.fname, avi.legacy_full_name, avi.status], ['Avi', 'Avi Detail', 'active']);
    assert.deepEqual(avi.phones.map((p: { phone: string; phone_normalized: string; is_primary: boolean }) => [p.phone, p.phone_normalized, p.is_primary]), [['347-555-0177', '3475550177', true]]);
    assert.deepEqual(avi.addresses.map((a: { kind: string; line1: string; city: string }) => [a.kind, a.line1, a.city]), [['home', '12 Elm St', 'Monsey']]);

    const byId = Object.fromEntries(f.children.map((c: { id: number }) => [c.id, c]));
    assert.equal(byId[linkedChild].linked, true);
    assert.equal(byId[draftChild].linked, false, 'a child with rights rows but not linked is listed too');
    assert.equal(typeof byId[linkedChild].class_id, 'number');
    const [[cls]] = await admin.query<RowDataPacket[]>(
      'SELECT cl.name FROM children c LEFT JOIN classes cl ON cl.id = c.class WHERE c.id = ?',
      [linkedChild],
    );
    assert.equal(byId[linkedChild].class_name, cls.name ?? null, 'classes.name, or null without a classes row');
    assert.deepEqual(
      byId[draftChild].rights.map((r: Record<string, unknown>) => [r.member_id, r.receives_notifications, r.notify_method, r.may_collect, r.collect_from, r.collect_to]),
      [[fm, true, 'sms', true, '2026-09-01', '2027-06-30']],
    );
    assert.deepEqual(byId[linkedChild].rights.map((r: Record<string, unknown>) => [r.member_id, r.is_payment_responsible]), [[gm, true]]);
  });

  test('404 for an unknown or a trashed family', async () => {
    assert.equal((await api('GET', '/families/2147483647')).statusCode, 404);
    const id = (await api('POST', '/families', { name: `${MARK} Trashed` })).json().id;
    await admin.query("UPDATE families SET status = 'trash' WHERE id = ?", [id]);
    const res = await api('GET', `/families/${id}`);
    assert.deepEqual(res.json(), { statusCode: 404, error: 'Not Found', message: `Family ${id} not found` });
    assert.equal((await api('PATCH', `/families/${id}`, { name: `${MARK} Back` })).statusCode, 404);
  });
});

describe('PATCH /families/:id', () => {
  test('edits name and household_phone, sets updated_by, audits only changed columns, re-mirrors linked children', async () => {
    const familyId = (await api('POST', '/families', { name: `${MARK} Edit`, household_phone: '718-555-0101' })).json().id;
    const [child] = await freeChildren(1);
    await admin.query('UPDATE children SET family_id = ? WHERE id = ?', [familyId, child]);
    linkedChildren.push(child);

    const res = await api('PATCH', `/families/${familyId}`, { name: `${MARK} Edited`, household_phone: '718-555-0102' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual([res.json().name, res.json().household_phone], [`${MARK} Edited`, '718-555-0102']);

    const [[row]] = await admin.query<RowDataPacket[]>('SELECT updated_by FROM families WHERE id = ?', [familyId]);
    assert.equal(row.updated_by, adminId);
    const [[mirrored]] = await admin.query<RowDataPacket[]>('SELECT home_phone FROM children WHERE id = ?', [child]);
    assert.equal(mirrored.home_phone, '718-555-0102', 'trg_families_au re-mirrored the linked child in the same transaction');

    await api('PATCH', `/families/${familyId}`, { name: `${MARK} Edited` }); // no change
    const [audit] = await admin.query<RowDataPacket[]>(
      "SELECT action, col_name, old_value, new_value FROM audit_logs WHERE table_name = 'families' AND table_id = ? AND action = 'update' ORDER BY id",
      [familyId],
    );
    assert.deepEqual(audit.map((r) => ({ ...r })), [
      { action: 'update', col_name: 'name', old_value: `${MARK} Edit`, new_value: `${MARK} Edited` },
      { action: 'update', col_name: 'household_phone', old_value: '718-555-0101', new_value: '718-555-0102' },
    ]);
  });
});

describe('GET /families (search)', () => {
  let alpha = 0;
  let beta = 0;

  before(async () => {
    alpha = (await api('POST', '/families', { name: `${MARK} Alpha`, household_phone: '(845) 555-0123' })).json().id;
    beta = (await api('POST', '/families', { name: `${MARK} Beta` })).json().id;
    const dov = await person('Dovber', `${MARK}lname`, `${MARK} Legacy Dov`);
    await insert("INSERT INTO people_phones (person_id, phone, phone_normalized, label, is_primary) VALUES (?, '917.555.0144', '9175550144', 'mobile', 1)", [dov]);
    const gone = await person(`${MARK}Ghost`, 'Trash', '', 'trash');
    await member(alpha, gone, 'uncle', { sort: 3 });
    const betaDov = await member(beta, dov, 'father', { sort: 0 });
    const [child, draft] = await freeChildren(2);
    await admin.query('UPDATE children SET family_id = ? WHERE id = ?', [beta, child]);
    linkedChildren.push(child);
    await insert('INSERT INTO family_member_children (member_id, child_id, receives_notifications) VALUES (?, ?, 1)', [betaDov, draft]);
  });

  const search = async (q: string, extra = '') => {
    const res = await api('GET', `/families?q=${encodeURIComponent(q)}${extra}`);
    assert.equal(res.statusCode, 200, res.body);
    return res.json();
  };
  const ids = (r: { items: { id: number }[] }) => r.items.map((i) => i.id);

  test('by family name, with member names, children (linked and draft) and counts', async () => {
    const r = await search(`${MARK} Be`);
    assert.deepEqual(ids(r), [beta]);
    const [item] = r.items;
    assert.deepEqual(item.members.map((m: { name: string; relationship: string }) => [m.name, m.relationship]), [[`Dovber ${MARK}lname`, 'father']]);
    assert.deepEqual(item.children.map((c: { linked: boolean }) => c.linked), [true, false], 'linked first, then children with rights rows');
    assert.deepEqual(Object.keys(item.children[0]).sort(), ['class_id', 'class_name', 'fname', 'id', 'linked', 'lname']);
    assert.deepEqual([item.member_count, item.child_count], [1, 2], 'child_count includes the draft child');

    const detail = (await api('GET', `/families/${beta}`)).json();
    assert.deepEqual(
      detail.children.map((c: { id: number; linked: boolean }) => [c.id, c.linked]),
      item.children.map((c: { id: number; linked: boolean }) => [c.id, c.linked]),
      'search and detail list the same children',
    );
  });

  test('anywhere in a name, ignoring case', async () => {
    const tail = MARK.slice(1); // drops the first letter, so only a "contains" match finds it
    assert.deepEqual(ids(await search(`${tail.toUpperCase()} BET`)), [beta], 'families.name');
    assert.deepEqual(ids(await search(`${tail.toLowerCase()}LNA`)), [beta], 'people.lname');
    assert.deepEqual(ids(await search(`${tail} legacy d`)), [beta], 'people.legacy_full_name');
    assert.ok(ids(await search('ovbe')).includes(beta), 'people.fname');
  });

  test('q needs at least 2 characters other than spaces', async () => {
    assert.equal((await api('GET', '/families?q=a')).statusCode, 400);
    const res = await api('GET', `/families?q=${encodeURIComponent(' a ')}`);
    assert.equal(res.statusCode, 400);
    assert.match(res.json().message, /at least 2 characters/);
    assert.equal((await api('GET', '/families?q=ab')).statusCode, 200);
  });

  test('by phone, as typed differently: people_phones and families.household_phone', async () => {
    assert.deepEqual(ids(await search('(917) 555-0144')), [beta]);
    assert.deepEqual(ids(await search('+1 845 555 0123')), [alpha]);
  });

  test('4-9 digits match the end of a phone; fewer digits search names', async () => {
    const byEnd = await search('0144');
    assert.ok(ids(byEnd).includes(beta) && !ids(byEnd).includes(alpha), 'people_phones.phone_normalized ends with 0144');
    const household = await search('555-0123');
    assert.ok(ids(household).includes(alpha) && !ids(household).includes(beta), 'household_phone_normalized ends with 5550123');
    assert.deepEqual(ids(await search('5550144 x9')), ids(await search('5550144')), 'an extension is dropped first');
    assert.ok(!ids(await search('144')).includes(beta), '3 digits are a name search');
  });

  test('only active families and members count; a trashed person is not found', async () => {
    assert.deepEqual(ids(await search(`${MARK}Ghost`)), []);
    await admin.query("UPDATE families SET status = 'trash' WHERE id = ?", [alpha]);
    assert.deepEqual(ids(await search(`${MARK} Alpha`)), []);
    await admin.query("UPDATE families SET status = 'active' WHERE id = ?", [alpha]);
  });

  test('page and pageSize; total counts all pages; % and _ match literally', async () => {
    const all = await search(MARK, '&pageSize=100');
    assert.ok(all.total >= 6);
    const p1 = await search(MARK, '&page=1&pageSize=2');
    const p2 = await search(MARK, '&page=2&pageSize=2');
    assert.deepEqual([p1.page, p1.page_size, p1.total, p1.items.length], [1, 2, all.total, 2]);
    assert.deepEqual([...ids(p1), ...ids(p2)], ids(all).slice(0, 4));
    assert.equal((await search(`${MARK}%`)).total, 0);
    assert.equal((await api('GET', '/families?pageSize=101')).statusCode, 400);
  });
});
