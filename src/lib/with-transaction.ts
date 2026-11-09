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
 * Runs a write on one connection at READ COMMITTED. Clears the mirror flag and audit user before the
 * connection returns to the pool. Retries the whole transaction once on MariaDB error 1213.
 *
 * READ COMMITTED matters: under REPEATABLE READ, a plain SELECT that runs before a transaction waits on a
 * family lock fixes its snapshot, and the mirror would then be derived from rows another save has
 * already replaced. At READ COMMITTED every statement reads the latest committed rows, and the row
 * locks taken with FOR UPDATE keep two saves of one family in order.
 *
 * If ROLLBACK fails, or the session variables cannot be cleared, the connection is destroyed rather than
 * released, so a connection with an open transaction or @family_mirror still set never reaches another request.
 */
export async function withTransaction<T>(
  pool: Pool,
  fn: (connection: PoolConnection) => Promise<T>,
): Promise<T> {
  let attempt = 0
  for (;;) {
    const connection = await pool.getConnection()
    let reusable = true
    try {
      await connection.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
      await connection.beginTransaction()
      const result = await fn(connection)
      await connection.commit()
      return result
    } catch (error) {
      try {
        await connection.rollback()
      } catch {
        // A connection whose transaction could not be closed is never reused, even if the reset below works.
        reusable = false
      }
      if (isDeadlock(error) && attempt === 0) {
        attempt += 1
        continue
      }
      throw error
    } finally {
      if (reusable) {
        try {
          await connection.query('SET @family_mirror = NULL, @audit_user = NULL')
        } catch {
          reusable = false
        }
      }
      if (reusable) {
        connection.release()
      } else {
        connection.destroy()
      }
    }
  }
}

/** A write made by one staff member. Sets @audit_user so the legacy ra_* triggers record that person. */
export async function withStaffTransaction<T>(
  pool: Pool,
  staffId: number,
  fn: (connection: PoolConnection) => Promise<T>,
): Promise<T> {
  return withTransaction(pool, async (connection) => {
    await connection.query('SET @audit_user = ?', [staffId])
    return fn(connection)
  })
}
