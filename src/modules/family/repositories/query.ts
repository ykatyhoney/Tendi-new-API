import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise'

export type Sql = Pool | PoolConnection

export async function rows<T extends RowDataPacket>(
  db: Sql,
  sql: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  const [result] = await db.query<T[]>(sql, params as unknown[])
  return result
}

export function placeholders(count: number): string {
  return new Array(count).fill('?').join(', ')
}
