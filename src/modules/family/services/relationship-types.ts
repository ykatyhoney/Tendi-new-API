import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise'
import { ApiError } from '../../../lib/api-error.js'
import { withStaffTransaction } from '../../../lib/with-transaction.js'
import { rows } from '../repositories/query.js'
import { listActiveRelationshipTypes } from '../repositories/relationship-types.js'
import type {
  CreateRelationshipTypeBody,
  PatchRelationshipTypeBody,
  RelationshipTypeList,
  RelationshipTypeResult,
} from '../schemas/relationship-type.js'
import { columnChanges, writeAudit } from './write/audit.js'
import { requireChange } from './write/rules.js'
import { asNullableString, asNumber, asString } from './values.js'

const LOCKED_TYPES = new Set(['father', 'mother', 'step_father', 'step_mother'])

interface StoredType extends RowDataPacket {
  code: string
  label: string
  parentSlot: 'father' | 'mother' | null
  slotRank: number | null
  sortOrder: number
  status: 'active' | 'inactive'
}

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

export async function createRelationshipType(
  pool: Pool,
  staffId: number,
  body: CreateRelationshipTypeBody,
): Promise<RelationshipTypeResult> {
  await withStaffTransaction(pool, staffId, async (connection) => {
    const existing = await lockType(connection, body.code)
    if (existing !== null) {
      throw new ApiError(409, 'DUPLICATE_CODE', 'That relationship code already exists.')
    }
    await connection.query(
      `INSERT INTO relationship_types
         (code, label, parent_slot, slot_rank, sort_order, status, created_at, updated_at, created_by, updated_by)
       VALUES (?, ?, NULL, NULL, ?, 'active', UTC_TIMESTAMP(), UTC_TIMESTAMP(), ?, ?)`,
      [body.code, body.label, body.sortOrder, staffId, staffId],
    )
    await writeAudit(
      connection,
      staffId,
      columnChanges(
        'relationship_types',
        null,
        'insert',
        {},
        { code: body.code, label: body.label, sort_order: String(body.sortOrder), status: 'active' },
        body.code,
      ),
    )
  })
  return finishType(pool, body.code)
}

export async function patchRelationshipType(
  pool: Pool,
  staffId: number,
  code: string,
  body: PatchRelationshipTypeBody,
): Promise<RelationshipTypeResult> {
  requireChange(body.label !== undefined || body.sortOrder !== undefined || body.status !== undefined)
  await withStaffTransaction(pool, staffId, async (connection) => {
    const current = await lockType(connection, code)
    if (current === null) {
      throw new ApiError(404, 'NOT_FOUND', 'Relationship type not found')
    }
    assertUnlocked(current, body)
    const next = {
      label: body.label ?? current.label,
      sort_order: String(body.sortOrder ?? current.sortOrder),
      status: body.status ?? current.status,
    }
    const changes = columnChanges(
      'relationship_types',
      null,
      'update',
      { label: current.label, sort_order: String(current.sortOrder), status: current.status },
      next,
      code,
    )
    if (changes.length > 0) {
      await connection.query(
        `UPDATE relationship_types
         SET label = ?, sort_order = ?, status = ?, updated_at = UTC_TIMESTAMP(), updated_by = ?
         WHERE code = ?`,
        [next.label, Number(next.sort_order), next.status, staffId, code],
      )
      await writeAudit(connection, staffId, changes)
    }
  })
  return finishType(pool, code)
}

function assertUnlocked(current: StoredType, body: PatchRelationshipTypeBody): void {
  if (!LOCKED_TYPES.has(current.code)) {
    return
  }
  const renaming = body.label !== undefined && body.label !== current.label
  const deactivating = body.status === 'inactive'
  if (renaming || deactivating) {
    throw new ApiError(409, 'LOCKED_TYPE', 'The parent relationship types cannot be renamed or deactivated.')
  }
}

async function lockType(connection: PoolConnection, code: string): Promise<StoredType | null> {
  const found = await rows<StoredType>(
    connection,
    `SELECT code, label, parent_slot AS parentSlot, slot_rank AS slotRank, sort_order AS sortOrder, status
     FROM relationship_types
     WHERE code = ?
     FOR UPDATE`,
    [code],
  )
  const row = found[0]
  if (row === undefined) {
    return null
  }
  return {
    ...row,
    code: String(row.code),
    label: String(row.label),
    parentSlot: row.parentSlot === 'father' || row.parentSlot === 'mother' ? row.parentSlot : null,
    slotRank: row.slotRank === null ? null : Number(row.slotRank),
    sortOrder: Number(row.sortOrder),
    status: row.status === 'inactive' ? 'inactive' : 'active',
  }
}

async function finishType(pool: Pool, code: string): Promise<RelationshipTypeResult> {
  const found = await rows<StoredType>(
    pool,
    `SELECT code, label, parent_slot AS parentSlot, slot_rank AS slotRank, sort_order AS sortOrder, status
     FROM relationship_types WHERE code = ?`,
    [code],
  )
  const row = found[0]
  if (row === undefined) {
    throw new ApiError(500, 'INTERNAL', 'Relationship type could not be read after it was saved.')
  }
  return {
    relationshipType: {
      code: String(row.code),
      label: String(row.label),
      parentSlot: row.parentSlot === 'father' || row.parentSlot === 'mother' ? row.parentSlot : null,
      slotRank: row.slotRank === null ? null : Number(row.slotRank),
      sortOrder: Number(row.sortOrder),
      status: row.status === 'inactive' ? 'inactive' : 'active',
    },
    affected_child_ids: [],
  }
}

function parentSlot(value: string | null): 'father' | 'mother' | null {
  if (value === 'father' || value === 'mother') {
    return value
  }
  return null
}
