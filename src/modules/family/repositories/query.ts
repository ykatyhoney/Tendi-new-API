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

/** SQL that selects matching ids as `id`, with its placeholder values. */
export interface SearchMatch {
  sql: string
  params: unknown[]
}

export function unionOf(branches: readonly SearchMatch[]): SearchMatch {
  return {
    sql: branches.map((branch) => branch.sql).join('\n     UNION\n     '),
    params: branches.flatMap((branch) => branch.params),
  }
}
