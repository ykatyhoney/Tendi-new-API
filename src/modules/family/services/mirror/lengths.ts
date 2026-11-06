import type { RowDataPacket } from 'mysql2/promise'
import { placeholders, rows, type Sql } from '../../repositories/query.js'
import { ADDITIONAL_MIRROR_COLUMNS, CHILDREN_MIRROR_COLUMNS } from './types.js'

let cached: Map<string, number> | undefined

/** Column character limits from information_schema. Loaded once per process. */
export async function legacyColumnLengths(db: Sql): Promise<ReadonlyMap<string, number>> {
  if (cached !== undefined) {
    return cached
  }
  const columns = [...CHILDREN_MIRROR_COLUMNS, ...ADDITIONAL_MIRROR_COLUMNS]
  const found = await rows<RowDataPacket>(
    db,
    `SELECT COLUMN_NAME AS name, CHARACTER_MAXIMUM_LENGTH AS maxLength
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND (
         (TABLE_NAME = 'children' AND COLUMN_NAME IN (${placeholders(CHILDREN_MIRROR_COLUMNS.length)}))
         OR (TABLE_NAME = 'children_additional_information' AND COLUMN_NAME IN (${placeholders(ADDITIONAL_MIRROR_COLUMNS.length)}))
       )`,
    columns,
  )
  const lengths = new Map<string, number>()
  for (const row of found) {
    if (row['maxLength'] !== null && row['maxLength'] !== undefined) {
      lengths.set(String(row['name']), Number(row['maxLength']))
    }
  }
  cached = lengths
  return lengths
}
