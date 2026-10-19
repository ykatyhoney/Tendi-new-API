// Connection and per-test transaction helpers for the family database suite.
// Connects only to the local test database (DB_TEST_NAME), never the development database,
// through scripts/family/lib/db.ts (local host, tendi_family_* name, hostname check).

import { after, afterEach, before, beforeEach } from 'node:test';
import type { Connection, RowDataPacket } from 'mysql2/promise';
import { connectLocal, loadEnv, requireEnv } from '../../../scripts/family/lib/db.ts';

export type Db = Connection;

export async function connect(): Promise<Db> {
  loadEnv();
  const database = requireEnv('DB_TEST_NAME');
  if (database === process.env.DB_NAME) {
    throw new Error(`refusing to test against '${database}': DB_TEST_NAME must differ from DB_NAME`);
  }
  return connectLocal(database);
}

/**
 * Opens one connection for the file and wraps every test in a transaction that is rolled
 * back afterwards. Session variables used by the mirror are cleared before each test.
 */
export function useTestDatabase(): () => Db {
  let db: Db | undefined;
  before(async () => {
    db = await connect();
  });
  beforeEach(async () => {
    await db!.query('SET @family_mirror = NULL, @audit_user = NULL');
    await db!.beginTransaction();
  });
  afterEach(async () => {
    await db!.rollback();
  });
  after(async () => {
    await db?.end();
  });
  return () => db!;
}

export async function rows<T = RowDataPacket>(db: Db, sql: string, params: unknown[] = []): Promise<T[]> {
  const [result] = await db.query<RowDataPacket[]>(sql, params);
  return result as T[];
}

export async function value<T = unknown>(db: Db, sql: string, params: unknown[] = []): Promise<T> {
  const [first] = await rows(db, sql, params);
  if (!first) throw new Error(`no row for: ${sql}`);
  return Object.values(first)[0] as T;
}

/** Runs a statement and returns how long it took, in milliseconds. */
export async function timed(db: Db, sql: string, params: unknown[] = []): Promise<number> {
  const started = performance.now();
  await db.query(sql, params);
  return performance.now() - started;
}
