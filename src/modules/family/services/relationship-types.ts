import type { Pool } from 'mysql2/promise'
import { listActiveRelationshipTypes } from '../repositories/relationship-types.js'
import type { RelationshipTypeList } from '../schemas/relationship-type.js'
import { asNullableString, asNumber, asString } from './values.js'

export async function listRelationshipTypes(db: Pool): Promise<RelationshipTypeList> {
  const types = await listActiveRelationshipTypes(db)
  return {
    items: types.map((row) => ({
      code: asString(row.code),
      label: asString(row.label),
      parentSlot: parentSlot(asNullableString(row.parentSlot)),
      slotRank: row.slotRank === null ? null : asNumber(row.slotRank),
      sortOrder: asNumber(row.sortOrder),
      status: 'active' as const,
    })),
  }
}

function parentSlot(value: string | null): 'father' | 'mother' | null {
  if (value === 'father' || value === 'mother') {
    return value
  }
  return null
}
