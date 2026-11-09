import type { Connection, Pool, PoolConnection } from 'mysql2/promise'

/**
 * Revision 4 of tendi_family_module.sql locks children.family_id: a change is put back and logged unless it
 * comes from family_api with @family_mirror = 1 on the same connection. Test fixtures that link or relink a
 * child go through this helper. The flag is cleared before the connection goes back to the pool, and a
 * connection whose flag can't be cleared is destroyed instead.
 */
export async function asFamilyApi<T>(pool: Pool, fn: (connection: PoolConnection) => Promise<T>): Promise<T> {
  const connection = await pool.getConnection()
  try {
    await connection.query('SET @family_mirror = 1')
    return await fn(connection)
  } finally {
    try {
      await connection.query('SET @family_mirror = NULL')
      connection.release()
    } catch {
      connection.destroy()
    }
  }
}

/**
 * The emergency unlink from revision 4: with @family_unlink = 1 any account (root included) may set family_id
 * to NULL. It can't link or relink. Only for fixtures that put a borrowed child back to unlinked.
 */
export async function unlinkWithFlag(connection: Connection, childId: number): Promise<void> {
  await connection.query('SET @family_unlink = 1')
  try {
    await connection.query('UPDATE children SET family_id = NULL WHERE id = ?', [childId])
  } finally {
    await connection.query('SET @family_unlink = NULL')
  }
}
