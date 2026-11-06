import type { Pool, RowDataPacket } from 'mysql2/promise'
import { rows } from './query.js'

export interface RelationshipTypeRow extends RowDataPacket {
  code: string
  label: string
  parentSlot: 'father' | 'mother' | null
  slotRank: number | null
  sortOrder: number
  status: 'active'
}

export async function listActiveRelationshipTypes(db: Pool): Promise<RelationshipTypeRow[]> {
  return rows<RelationshipTypeRow>(
    db,
    `SELECT code, label, parent_slot AS parentSlot, slot_rank AS slotRank, sort_order AS sortOrder, status
     FROM relationship_types
     WHERE status = 'active'
     ORDER BY sort_order, code`,
  )
}
