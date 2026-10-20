// The Family API business-rule checks are wired into the routes and run after the staff auth:
// a valid token gets 400 for a rule violation and 501 (not implemented yet) for a valid request;
// a refused staff type gets 403 before any rule is checked. Against tendi_family_test.

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import type { Connection, RowDataPacket } from 'mysql2/promise';
import { buildApp, type App } from '../../src/app.ts';
import { loadConfig } from '../../src/config.ts';
import { connectLocal, loadEnv, requireEnv } from '../../scripts/family/lib/db.ts';

let admin: Connection;
let app: App;
const token = { staff: randomBytes(24).toString('hex'), teacher: randomBytes(24).toString('hex') };

async function issue(type: string, value: string) {
  const [[row]] = await admin.query<RowDataPacket[]>(
    "SELECT id FROM admin WHERE type = ? AND status = 'active' ORDER BY id LIMIT 1",
    [type],
  );
  await admin.query(
    `INSERT INTO admin_api_tokens (admin_id, token_hash, device_id, created_at, last_seen_at)
     VALUES (?, MD5(?), 'family-contract-test', NOW(), NOW())`,
    [row.id, value],
  );
}

before(async () => {
  loadEnv();
  const database = requireEnv('DB_TEST_NAME');
  admin = await connectLocal(database);
  await issue('admin', token.staff);
  await issue('teacher', token.teacher);
  const config = loadConfig();
  app = await buildApp({ ...config, logLevel: 'silent', redisUrl: undefined, db: { ...config.db, database } });
});

after(async () => {
  await app?.close();
  await admin.query("DELETE FROM admin_api_tokens WHERE device_id = 'family-contract-test'");
  await admin.end();
});

const call = (method: 'POST' | 'PUT' | 'PATCH', url: string, payload: object, as = token.staff) =>
  app.inject({ method, url, payload, headers: { authorization: `Bearer ${as}` } });

describe('family API rules through the routes', () => {
  test('phones: two primaries -> 400; one primary -> passes the checks (501 until implemented)', async () => {
    const bad = await call('PUT', '/people/1/phones', {
      phones: [
        { phone: '718-555-0101', label: 'mobile', is_primary: true },
        { phone: '718-555-0102', label: 'home', is_primary: true },
      ],
    });
    assert.equal(bad.statusCode, 400);
    assert.deepEqual(bad.json(), {
      statusCode: 400,
      error: 'Bad Request',
      message: 'phones: exactly one phone must have is_primary = true (found 2)',
    });

    const ok = await call('PUT', '/people/1/phones', { phones: [{ phone: '718-555-0101', label: 'mobile', is_primary: true }] });
    assert.equal(ok.statusCode, 501);
    assert.equal(ok.json().message, 'replacePersonPhones is not implemented yet');
  });

  test('rights: collect_to before collect_from -> 400', async () => {
    const res = await call('PUT', '/families/1/children/2/rights', {
      rights: [{ member_id: 1, may_collect: true, collect_from: '2026-10-01', collect_to: '2026-09-30' }],
    });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().message, /rights\/0\/collect_to: must be on or after collect_from/);
  });

  test('add member: person_id and person together -> 400; email over 150 characters -> 400', async () => {
    const both = await call('POST', '/families/1/members', {
      person_id: 5,
      person: { fname: 'A', lname: 'B' },
      relationship: 'grandmother',
    });
    assert.equal(both.statusCode, 400);
    assert.match(both.json().message, /exactly one of person_id/);

    const email = await call('PATCH', '/people/1', { email: `${'a'.repeat(140)}@example.test` });
    assert.equal(email.statusCode, 400);
    assert.match(email.json().message, /varchar\(150\)/);
  });

  const invalid = async (method: 'POST' | 'PUT' | 'PATCH', url: string, payload: object, pattern: RegExp) => {
    const res = await call(method, url, payload);
    assert.equal(res.statusCode, 400, `${method} ${url}: ${res.body}`);
    const json = res.json();
    assert.deepEqual(Object.keys(json).sort(), ['error', 'message', 'statusCode']);
    assert.equal(json.error, 'Bad Request');
    assert.match(json.message, pattern);
  };

  test('schema violations answer 400 in the error format', async () => {
    await invalid('POST', '/families', { name: 'x'.repeat(101) }, /name/);
    await invalid('POST', '/families', { name: '' }, /name/);
    await invalid('POST', '/families/1/members', { person_id: 5, relationship: 'nephew' }, /relationship/);
    await invalid('PATCH', '/families/1/members/2', {}, /fewer than 1 properties|minProperties/i);
    await invalid('PUT', '/people/1/phones', { phones: [{ phone: '718-555-0101', label: 'pager' }] }, /label/);
    await invalid('PUT', '/people/1/phones', { phones: [{ phone: '1', label: 'home', channel: 'fax' }] }, /channel/);
    await invalid('PUT', '/people/1/addresses', { addresses: [{ kind: 'vacation', line1: 'x' }] }, /kind/);
    await invalid('PUT', '/people/1/addresses', { addresses: [{ kind: 'home', state: 'x'.repeat(26) }] }, /state/);
    await invalid('PUT', '/families/1/children/2/rights', { rights: [{ member_id: 1, notify_method: 'email' }] }, /notify_method/);
    await invalid('PUT', '/families/1/children/2/rights', { rights: [{ member_id: 1, collect_from: '2026-13-40' }] }, /collect_from/);
    await invalid('PATCH', '/people/0', { fname: 'A' }, /id/);
  });

  test('unknown fields are rejected with 400, not dropped', async () => {
    await invalid('PATCH', '/people/1', { fnmae: 'Avi' }, /must NOT have additional properties/);
    await invalid(
      'PUT',
      '/people/1/phones',
      { phones: [{ phone: '718-555-0101', label: 'mobile', is_primary: true, phone_normalized: '7185550101' }] },
      /additional properties/,
    );
    const query = await app.inject({
      method: 'GET',
      url: '/families?q=Katz&pagesize=10',
      headers: { authorization: `Bearer ${token.staff}` },
    });
    assert.equal(query.statusCode, 400);
    assert.match(query.json().message, /additional properties/);
  });

  test('mirror limits: household_phone over 30 characters, default legacy name over 100', async () => {
    await invalid('POST', '/families', { name: 'Katz', household_phone: '718-555-0101 ext 4455 evenings' + 'x' }, /household_phone.*30/);
    await invalid('PATCH', '/families/1', { household_phone: 'x'.repeat(31) }, /household_phone/);
    await invalid(
      'POST',
      '/families/1/members',
      { person: { fname: 'a'.repeat(60), lname: 'b'.repeat(60) }, relationship: 'father' },
      /legacy_full_name defaults to "fname lname"/,
    );
    const ok = await call('POST', '/families/1/members', {
      person: { fname: 'a'.repeat(60), lname: 'b'.repeat(60), legacy_full_name: 'A B' },
      relationship: 'father',
    });
    assert.equal(ok.statusCode, 501, 'an explicit legacy_full_name lifts the limit');
  });

  test('a refused staff type gets 403 before any rule is checked', async () => {
    const res = await call('PUT', '/people/1/phones', { phones: [{ phone: '1', label: 'mobile' }] }, token.teacher);
    assert.equal(res.statusCode, 403);
  });
});
