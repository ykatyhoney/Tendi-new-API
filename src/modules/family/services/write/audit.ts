import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { placeholders, rows } from '../../repositories/query.js'

export type AuditAction = 'insert' | 'update' | 'delete'

export interface AuditChange {
  table: string
  id: number
  action: AuditAction
  column: string
  oldValue: string | null
  newValue: string | null
}

export function auditValue(value: string | number | null): string | null {
  return value === null ? null : String(value)
}

export function columnChanges(
  table: string,
  id: number,
  action: AuditAction,
  before: Record<string, string | null>,
  after: Record<string, string | null>,
): AuditChange[] {
  const changes: AuditChange[] = []
  for (const column of Object.keys(after)) {
    const oldValue = before[column] ?? null
    const newValue = after[column] ?? null
    if (oldValue !== newValue) {
      changes.push({ table, id, action, column, oldValue, newValue })
    }
  }
  return changes
}

export async function writeAudit(
  connection: PoolConnection,
  staffId: number,
  changes: readonly AuditChange[],
): Promise<void> {
  if (changes.length === 0) {
    return
  }
  const values = changes.map(() => `(?, ?, ?, ?, ?, ?, ?, ?, 'staff', 'tendi-new')`).join(', ')
  const params = changes.flatMap((change) => [
    'family',
    change.table,
    change.action,
    change.column,
    change.oldValue,
    change.newValue,
    staffId,
    change.id,
  ])
  await connection.query<ResultSetHeader>(
    `INSERT INTO audit_logs
       (type, table_name, action, col_name, old_value, new_value, user_id, table_id, actor_type, actor_ref)
     VALUES ${values}`,
    params,
  )
}

export async function lockFamilies(connection: PoolConnection, familyIds: readonly number[]): Promise<void> {
  const ids = [...new Set(familyIds)].filter((id) => id > 0).sort((left, right) => left - right)
  if (ids.length === 0) {
    return
  }
  await rows<RowDataPacket>(
    connection,
    `SELECT id FROM families WHERE id IN (${placeholders(ids.length)}) ORDER BY id FOR UPDATE`,
    ids,
  )
}

export async function familyIdsForContact(connection: PoolConnection, contactId: number): Promise<number[]> {
  const found = await rows<RowDataPacket>(
    connection,
    `SELECT DISTINCT family_id AS familyId
     FROM family_members
     WHERE family_contact_id = ? AND status = 'active'
     ORDER BY family_id`,
    [contactId],
  )
  return found.map((row) => Number(row['familyId']))
}

export async function insertId(connection: PoolConnection, sql: string, params: readonly unknown[]): Promise<number> {
  const [header] = await connection.query<ResultSetHeader>(sql, params as unknown[])
  return header.insertId
}
