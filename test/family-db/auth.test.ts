// Staff authentication and the staff-type guard on the Family API (src/modules/family/auth.ts),
// through app.inject() against tendi_family_test. Tokens are created for existing admins and
// deleted afterwards; the admin made inactive for one test is restored.

import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import type { Connection, RowDataPacket } from 'mysql2/promise';
import { buildApp, type App } from '../../src/app.ts';
import { loadConfig } from '../../src/config.ts';
import { connectLocal, loadEnv, requireEnv } from '../../scripts/family/lib/db.ts';

let admin: Connection;
let app: App;
const tokens: Record<string, string> = {};
const adminIds: Record<string, number> = {};
let inactiveOriginalStatus = '';

async function firstAdmin(type: string, offset = 0): Promise<number> {
  const [rows] = await admin.query<RowDataPacket[]>(
    "SELECT id FROM admin WHERE type = ? AND status = 'active' ORDER BY id LIMIT 1 OFFSET ?",
    [type, offset],
  );
  assert.ok(rows[0], `need an active admin of type ${type}`);
  return rows[0].id;
}

async function issueToken(label: string, adminId: number): Promise<void> {
  const token = randomBytes(24).toString('hex');
  await admin.query(
    `INSERT INTO admin_api_tokens (admin_id, token_hash, device_id, created_at, last_seen_at)
     VALUES (?, MD5(?), 'family-auth-test', NOW(), NOW() - INTERVAL 1 DAY)`,
    [adminId, token],
  );
  tokens[label] = token;
  adminIds[label] = adminId;
}

const me = (token?: string) =>
  app.inject({ method: 'GET', url: '/staff/me', headers: token ? { authorization: `Bearer ${token}` } : {} });

before(async () => {
  loadEnv();
  const database = requireEnv('DB_TEST_NAME');
  admin = await connectLocal(database);
  await issueToken('admin', await firstAdmin('admin'));
  await issueToken('office', await firstAdmin('office'));
  await issueToken('teacher', await firstAdmin('teacher'));
  await issueToken('superadmin', await firstAdmin('superadmin'));
  await issueToken('developer', await firstAdmin('developer'));
  const inactive = await firstAdmin('admin', 1);
  const [[row]] = await admin.query<RowDataPacket[]>('SELECT status FROM admin WHERE id = ?', [inactive]);
  inactiveOriginalStatus = row.status;
  await admin.query("UPDATE admin SET status = 'inactive' WHERE id = ?", [inactive]);
  await issueToken('inactive', inactive);

  const config = loadConfig();
  app = await buildApp({ ...config, logLevel: 'silent', redisUrl: undefined, db: { ...config.db, database } });
});

after(async () => {
  await app?.close();
  await admin.query("DELETE FROM admin_api_tokens WHERE device_id = 'family-auth-test'");
  if (inactiveOriginalStatus) {
    await admin.query('UPDATE admin SET status = ? WHERE id = ?', [inactiveOriginalStatus, adminIds.inactive]);
  }
  await admin.end();
});

describe('family staff auth', () => {
  test('a valid token of an allowed type: 200, request.staff set, last_seen_at updated', async () => {
    const res = await me(tokens.admin);
    assert.equal(res.statusCode, 200);
    const [[a]] = await admin.query<RowDataPacket[]>(
      "SELECT TRIM(CONCAT(fname, ' ', lname)) AS name FROM admin WHERE id = ?",
      [adminIds.admin],
    );
    assert.deepEqual(res.json(), { admin_id: adminIds.admin, type: 'admin', name: a.name });

    const [[t]] = await admin.query<RowDataPacket[]>(
      "SELECT last_seen_at > NOW() - INTERVAL 1 MINUTE AS fresh FROM admin_api_tokens WHERE token_hash = MD5(?)",
      [tokens.admin],
    );
    assert.equal(t.fresh, 1);

    assert.equal((await me(tokens.office)).statusCode, 200, 'office is allowed');
  });

  test('missing or malformed Authorization header: 401 with WWW-Authenticate', async () => {
    for (const res of [
      await me(),
      await app.inject({ method: 'GET', url: '/staff/me', headers: { authorization: `Basic ${tokens.admin}` } }),
    ]) {
      assert.equal(res.statusCode, 401);
      assert.equal(res.headers['www-authenticate'], 'Bearer');
      assert.equal(res.json().error, 'Unauthorized');
    }
  });

  test('unknown token: 401', async () => {
    const res = await me(randomBytes(24).toString('hex'));
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.json(), { statusCode: 401, error: 'Unauthorized', message: 'Invalid or expired token' });
  });

  test('inactive admin: 401, same answer as an unknown token', async () => {
    const res = await me(tokens.inactive);
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.json(), { statusCode: 401, error: 'Unauthorized', message: 'Invalid or expired token' });
  });

  test('a staff type outside FAMILY_ALLOWED_STAFF_TYPES: 403, and last_seen_at is not touched', async () => {
    const teacher = await me(tokens.teacher);
    assert.equal(teacher.statusCode, 403);
    assert.deepEqual(teacher.json(), {
      statusCode: 403,
      error: 'Forbidden',
      message: "Staff type 'teacher' may not use the Family API",
    });
    assert.equal((await me(tokens.developer)).statusCode, 403, 'developer is not in the default list');
    assert.equal((await me(tokens.superadmin)).statusCode, 403, 'superadmin is not in the default list (D5: admin, office)');

    const [stale] = await admin.query<RowDataPacket[]>(
      'SELECT COUNT(*) AS n FROM admin_api_tokens WHERE token_hash IN (MD5(?), MD5(?)) AND last_seen_at < NOW() - INTERVAL 23 HOUR',
      [tokens.teacher, tokens.developer],
    );
    assert.equal(stale[0].n, 2, 'a refused request does not count as a use of the token');
  });

  test('the token hash is md5 of the token, as admin.login_auth stores it', () => {
    assert.equal(createHash('md5').update(tokens.admin).digest('hex').length, 32);
  });

  test('GET /health/family stays public', async () => {
    assert.equal((await app.inject({ method: 'GET', url: '/health/family' })).statusCode, 200);
  });
});
