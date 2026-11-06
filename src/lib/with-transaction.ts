import type { Pool, PoolConnection } from 'mysql2/promise'

const DEADLOCK_ERRNO = 1213

export function isDeadlock(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'errno' in error &&
    (error as { errno: unknown }).errno === DEADLOCK_ERRNO
  )
}

/**
 * Runs a write on one connection. Clears the mirror flag and audit user before the
 * connection returns to the pool. Retries the whole transaction once on MariaDB error 1213.
 */
export async function withTransaction<T>(
  pool: Pool,
  fn: (connection: PoolConnection) => Promise<T>,
): Promise<T> {
  let attempt = 0
  for (;;) {
    const connection = await pool.getConnection()
    try {
      await connection.beginTransaction()
      const result = await fn(connection)
      await connection.commit()
      return result
    } catch (error) {
      try {
        await connection.rollback()
      } catch {
        // A deadlock can leave the connection unable to roll back.
      }
      if (isDeadlock(error) && attempt === 0) {
        attempt += 1
        continue
      }
      throw error
    } finally {
      try {
        await connection.query('SET @family_mirror = NULL, @audit_user = NULL')
      } catch {
        // The connection is already unusable. Releasing it is enough.
      }
      connection.release()
    }
  }
}
