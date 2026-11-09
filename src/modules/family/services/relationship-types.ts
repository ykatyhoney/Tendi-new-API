import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise'
import { ApiError } from '../../../lib/api-error.js'
import { withStaffTransaction } from '../../../lib/with-transaction.js'
import { rows, type Sql } from '../repositories/query.js'
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

export async function listRelationshipTypes(db: Sql): Promise<RelationshipTypeList> {
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
  return withStaffTransaction(pool, staffId, async (connection) => {
    const existing = await lockType(connection, body.code)
    if (existing !== null) {
      throw duplicateCode()
    }
    try {
      await connection.query(
        `INSERT INTO relationship_types
           (code, label, parent_slot, slot_rank, sort_order, status, created_at, updated_at, created_by, updated_by)
         VALUES (?, ?, NULL, NULL, ?, 'active', UTC_TIMESTAMP(), UTC_TIMESTAMP(), ?, ?)`,
        [body.code, body.label, body.sortOrder, staffId, staffId],
      )
    } catch (error) {
      // FOR UPDATE on a missing row takes no lock at READ COMMITTED, so two creates of one code can both
      // pass the check above. The primary key stops the second one.
      if (isDuplicateKey(error)) {
        throw duplicateCode()
      }
      throw error
    }
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
    return finishType(connection, body.code)
  })
}

export async function patchRelationshipType(
  pool: Pool,
  staffId: number,
  code: string,
  body: PatchRelationshipTypeBody,
): Promise<RelationshipTypeResult> {
  requireChange(body.label !== undefined || body.sortOrder !== undefined || body.status !== undefined)
  return withStaffTransaction(pool, staffId, async (connection) => {
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
    return finishType(connection, code)
  })
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

async function finishType(connection: PoolConnection, code: string): Promise<RelationshipTypeResult> {
  const found = await rows<StoredType>(
    connection,
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

function duplicateCode(): ApiError {
  return new ApiError(409, 'DUPLICATE_CODE', 'That relationship code already exists.')
}

function isDuplicateKey(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'errno' in error && Number(error.errno) === 1062
}

function parentSlot(value: string | null): 'father' | 'mother' | null {
  if (value === 'father' || value === 'mother') {
    return value
  }
  return null
}
