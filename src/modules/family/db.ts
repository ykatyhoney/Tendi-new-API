// The family module's own connection pool, as family_api (scripts/family/grants.sql): it can read
// what the Family API needs, write the 6 family tables, children.family_id and audit_logs, and
// call sp_family_preview. It cannot write any legacy parent column; the database mirror does.
//
// Every write goes through familyDb.transaction (the app's withTransaction on this pool): one
// transaction per request, @audit_user set to the staff member, committed only if all of it
// succeeds. Reads use pool.query / pool.execute directly.

import type { Pool, PoolConnection } from 'mysql2/promise';
import type { Config } from '../../config.ts';
import { createPool } from '../../db/pool.ts';
import { type TransactionOptions, withTransaction } from '../../db/transaction.ts';
import type { FamilyConfig } from './config.ts';

/** What repositories run queries on: the pool (reads) or a transaction's connection (writes). */
export type Queryable = Pool | PoolConnection;

export interface FamilyDb {
  pool: Pool;
  /** The only way a family route writes. */
  transaction<T>(work: (connection: PoolConnection) => Promise<T>, options: TransactionOptions): Promise<T>;
}

export function createFamilyDb(appDb: Config['db'], family: FamilyConfig): FamilyDb {
  const pool = createPool({
    ...appDb,
    user: family.db.user,
    password: family.db.password,
    poolSize: family.db.poolSize,
  });
  return {
    pool,
    transaction: (work, options) => withTransaction(pool, work, options),
  };
}
