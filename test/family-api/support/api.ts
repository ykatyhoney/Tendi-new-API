// The Family API test harness (npm run test:family-api): the app through app.inject() against
// tendi_family_test, with every test rolled back.
//
// useApi() builds the app on ONE connection as family_api (the API's real database account and
// grants) and wraps each test in a transaction that is rolled back afterwards. The app's writes
// become savepoints inside it (rollbackFamilyDb mirrors src/db/transaction.ts: @audit_user set,
// @family_mirror cleared, rolled back on error), and its reads use the same connection, so a test
// sees its own uncommitted rows and leaves nothing behind.
//
// Committed once per file, by the database root account, and removed in after(): a bearer token
// for an office, an admin and a teacher (403) account. family_api cannot write admin_api_tokens.
//
// Rolling back is not possible where a second account must write while the API's changes are
// open (a legacy-style UPDATE of a mirrored column, which family_api may not do, would wait on the
// open transaction's row locks): test/family-api/e2e.test.ts commits and cleans up instead.

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, afterEach, before, beforeEach } from 'node:test';
import type { Connection, Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { buildApp, type App } from '../../../src/app.ts';
import { loadConfig } from '../../../src/config.ts';
import { loadFamilyConfig } from '../../../src/modules/family/config.ts';
import type { FamilyDb } from '../../../src/modules/family/db.ts';
import { connectLocal, loadEnv, requireEnv } from '../../../scripts/family/lib/db.ts';

export type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
export type Staff = 'office' | 'admin' | 'teacher';
/** Whose token a request sends: a harness staff member, a raw token, or none (null). */
export type As = Staff | { token: string } | null;

const DEVICE = 'family-api-test';

/** A FamilyDb on one connection whose writes are savepoints of the test's transaction. */
function rollbackFamilyDb(conn: Connection): FamilyDb {
  const pool = {
    query: conn.query.bind(conn),
    execute: conn.execute.bind(conn),
    end: async () => {},
  } as unknown as Pool;
  return {
    pool,
    async transaction(work, options) {
      await conn.query('SET @audit_user = ?, @family_mirror = NULL', [options.auditUser ?? null]);
      await conn.query('SAVEPOINT api_write');
      try {
        const result = await work(conn as unknown as PoolConnection);
        await conn.query('RELEASE SAVEPOINT api_write');
        return result;
      } catch (error) {
        await conn.query('ROLLBACK TO SAVEPOINT api_write');
        throw error;
      } finally {
        await conn.query('SET @audit_user = NULL, @family_mirror = NULL');
      }
    },
  };
}

/** What app.inject() resolves to, as far as the tests read it. */
export interface Response {
  statusCode: number;
  headers: Record<string, string | string[] | number | undefined>;
  body: string;
  json(): any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export interface Api {
  /** The raw response; `as` picks the token (default the office staff member). */
  request(method: Method, url: string, payload?: object, as?: As): Promise<Response>;
  /** The JSON body, asserting the status (default 200). */
  ok(method: Method, url: string, payload?: object, status?: number): Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  /** The error message, asserting the status and the error format. */
  fails(method: Method, url: string, status: number, payload?: object): Promise<string>;
  /** The test's connection (family_api, inside the rolled-back transaction). */
  db(): Connection;
  adminId(as?: Staff): number;
}

export function useApi(): Api {
  let root: Connection;
  let conn: Connection;
  let app: App;
  const tokens = {} as Record<Staff, string>;
  const adminIds = {} as Record<Staff, number>;

  before(async () => {
    loadEnv();
    const database = requireEnv('DB_TEST_NAME');
    if (database === process.env.DB_NAME) throw new Error('DB_TEST_NAME must differ from DB_NAME');
    root = await connectLocal(database);
    for (const type of ['office', 'admin', 'teacher'] as const) {
      const [[row]] = await root.query<RowDataPacket[]>(
        "SELECT id FROM admin WHERE type = ? AND status = 'active' ORDER BY id LIMIT 1",
        [type],
      );
      assert.ok(row, `need an active admin of type ${type}`);
      tokens[type] = randomBytes(24).toString('hex');
      adminIds[type] = row.id;
      await root.query(
        `INSERT INTO admin_api_tokens (admin_id, token_hash, device_id, created_at, last_seen_at)
         VALUES (?, MD5(?), ?, NOW(), NOW())`,
        [row.id, tokens[type], DEVICE],
      );
    }
    const family = loadFamilyConfig();
    conn = await connectLocal(database, { user: family.db.user, password: family.db.password });
    const config = loadConfig();
    app = await buildApp(
      { ...config, logLevel: 'silent', redisUrl: undefined, db: { ...config.db, database } },
      { familyDb: rollbackFamilyDb(conn) },
    );
  });

  beforeEach(async () => {
    await conn.query('SET @audit_user = NULL, @family_mirror = NULL');
    await conn.query('START TRANSACTION');
  });

  afterEach(async () => {
    await conn.query('ROLLBACK');
  });

  after(async () => {
    await app?.close();
    await conn?.end();
    await root?.query('DELETE FROM admin_api_tokens WHERE device_id = ?', [DEVICE]);
    await root?.end();
  });

  const request: Api['request'] = (method, url, payload, as = 'office') => {
    const token = as === null ? null : typeof as === 'string' ? tokens[as] : as.token;
    return app.inject({ method, url, payload, headers: token ? { authorization: `Bearer ${token}` } : {} });
  };

  return {
    request,
    async ok(method, url, payload, status = 200) {
      const res = await request(method, url, payload);
      assert.equal(res.statusCode, status, `${method} ${url}: ${res.body}`);
      return res.json();
    },
    async fails(method, url, status, payload) {
      const res = await request(method, url, payload);
      assert.equal(res.statusCode, status, `${method} ${url}: ${res.body}`);
      const body = res.json();
      assert.deepEqual(Object.keys(body).sort(), ['error', 'message', 'statusCode']);
      assert.equal(body.statusCode, status);
      return body.message;
    },
    db: () => conn,
    adminId: (as = 'office') => adminIds[as],
  };
}

// --- Fixtures, made through the API (so they roll back with the test) ---------------------------

export async function newFamily(api: Api, name: string, householdPhone = '718-555-0300'): Promise<number> {
  return (await api.ok('POST', '/families', { name, household_phone: householdPhone }, 201)).id;
}

/** A new person as a member; with `phone`, also their primary mobile phone. */
export async function newMember(
  api: Api,
  familyId: number,
  fname: string,
  relationship: string,
  { phone, ...extra }: { phone?: string; is_primary?: boolean; sort_order?: number } = {},
): Promise<{ id: number; person_id: number }> {
  const m = await api.ok(
    'POST',
    `/families/${familyId}/members`,
    { person: { fname, lname: 'Testerman' }, relationship, ...extra },
    201,
  );
  if (phone) {
    await api.ok('PUT', `/people/${m.person_id}/phones`, { phones: [{ phone, label: 'mobile', is_primary: true }] });
  }
  return m;
}

/** Active, unlinked children with a children_additional_information row (the same ones each test). */
export async function freeChildren(api: Api, count: number): Promise<number[]> {
  const [rows] = await api.db().query<RowDataPacket[]>(
    `SELECT c.id FROM children c JOIN children_additional_information cai ON cai.child_id = c.id
        WHERE c.status = 'active' AND c.family_id IS NULL ORDER BY c.id LIMIT ?`,
    [count],
  );
  assert.equal(rows.length, count);
  return rows.map((r) => r.id);
}

/** A family with a father (primary phone) who has rights for each child, ready to link. */
export async function readyFamily(api: Api, name: string, childIds: number[]) {
  const familyId = await newFamily(api, name);
  const father = await newMember(api, familyId, 'Avi', 'father', { phone: '347-555-0101', is_primary: true });
  for (const childId of childIds) {
    await api.ok('PUT', `/families/${familyId}/children/${childId}/rights`, {
      rights: [{ member_id: father.id, receives_notifications: true, is_payment_responsible: true }],
    });
  }
  return { familyId, father };
}

export const NO_ID = 2147483647;
