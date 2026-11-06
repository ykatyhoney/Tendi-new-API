import type { PoolConnection, ResultSetHeader } from 'mysql2/promise'
import { quoteIdentifier } from '../../../../lib/sql.js'
import { assertLegacyLengths, deriveLegacyValues, legacyColumnValue, sameLegacyValue } from './derive.js'
import { legacyColumnLengths } from './lengths.js'
import { loadChildren } from './load.js'
import {
  ADDITIONAL_MIRROR_COLUMNS,
  CHILDREN_MIRROR_COLUMNS,
  type LegacyColumn,
  type LegacyValues,
} from './types.js'

/**
 * Writes the 28 old parent columns for these children. The caller owns the transaction.
 * Returns the child ids whose stored values changed.
 */
export async function writeMirror(connection: PoolConnection, childIds: readonly number[]): Promise<number[]> {
  const ids = [...new Set(childIds)]
  if (ids.length === 0) {
    return []
  }
  const lengths = await legacyColumnLengths(connection)
  const changed: number[] = []
  await connection.query('SET @family_mirror = 1')
  try {
    const loaded = await loadChildren(connection, ids)
    for (const row of loaded) {
      const derived = deriveLegacyValues(row.child, row.family)
      assertLegacyLengths(derived, lengths)
      const childChanges = changedColumns(row.stored, derived, CHILDREN_MIRROR_COLUMNS)
      const additionalChanges = changedColumns(row.stored, derived, ADDITIONAL_MIRROR_COLUMNS)
      if (!row.hasAdditional) {
        await insertAdditional(connection, row.child.id, derived)
      } else if (additionalChanges.length > 0) {
        await updateColumns(connection, 'children_additional_information', 'child_id', row.child.id, derived, additionalChanges)
      }
      if (childChanges.length > 0) {
        await updateColumns(connection, 'children', 'id', row.child.id, derived, childChanges)
      }
      if (!row.hasAdditional || childChanges.length > 0 || additionalChanges.length > 0) {
        changed.push(row.child.id)
      }
    }
  } finally {
    await connection.query('SET @family_mirror = NULL')
  }
  changed.sort((a, b) => a - b)
  return changed
}

function changedColumns(
  stored: LegacyValues,
  derived: LegacyValues,
  columns: readonly LegacyColumn[],
): LegacyColumn[] {
  return columns.filter((column) => !sameLegacyValue(legacyColumnValue(stored, column), legacyColumnValue(derived, column)))
}

async function updateColumns(
  connection: PoolConnection,
  table: 'children' | 'children_additional_information',
  idColumn: 'id' | 'child_id',
  id: number,
  values: LegacyValues,
  columns: readonly LegacyColumn[],
): Promise<void> {
  const assignments = columns.map((column) => `${quoteIdentifier(column)} = ?`)
  const params = columns.map((column) => legacyColumnValue(values, column))
  await connection.query<ResultSetHeader>(
    `UPDATE ${quoteIdentifier(table)} SET ${assignments.join(', ')} WHERE ${quoteIdentifier(idColumn)} = ?`,
    [...params, id],
  )
}

async function insertAdditional(connection: PoolConnection, childId: number, values: LegacyValues): Promise<void> {
  const columns = ['child_id', ...ADDITIONAL_MIRROR_COLUMNS]
  const params = [childId, ...ADDITIONAL_MIRROR_COLUMNS.map((column) => legacyColumnValue(values, column))]
  await connection.query(
    `INSERT INTO children_additional_information (${columns.map((column) => quoteIdentifier(column)).join(', ')})
     VALUES (${columns.map(() => '?').join(', ')})`,
    params,
  )
}
