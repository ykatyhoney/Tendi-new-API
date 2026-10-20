// withTransaction: every write route runs its work through this helper, so the work happens in
// one transaction on one connection, and is committed only if it completes.
//
// auditUser sets @audit_user for the duration: the tenant's ra_* audit triggers record it as the
// actor, including for rows the family mirror writes (CONTEXT.md, "Mirror and audit"). Session
// variables are cleared before the connection goes back to the pool.

import type { Pool, PoolConnection } from 'mysql2/promise';

export interface TransactionOptions {
  /** admin.id of the staff member making the change. */
  auditUser?: number;
}

export async function withTransaction<T>(
  pool: Pool,
  work: (connection: PoolConnection) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  const connection = await pool.getConnection();
  try {
    await connection.query('SET @audit_user = ?, @family_mirror = NULL', [options.auditUser ?? null]);
    await connection.beginTransaction();
    try {
      const result = await work(connection);
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      throw error;
    }
  } finally {
    try {
      await connection.query('SET @audit_user = NULL, @family_mirror = NULL');
      connection.release();
    } catch {
      connection.destroy();
    }
  }
}
