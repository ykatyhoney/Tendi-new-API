import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise'
import { ApiError } from '../../../lib/api-error.js'
import { withStaffTransaction } from '../../../lib/with-transaction.js'
import { rows } from '../repositories/query.js'
import type { LinkPreview, LinkResult, ReplaceRightsBody, RightsResult, UnlinkResult } from '../schemas/link.js'
import { auditValue, columnChanges, insertId, lockFamilies, writeAudit, type AuditChange } from './write/audit.js'
import { characterLength, deriveLegacyValues, legacyColumnValue, sameLegacyValue, valueAfterMirror } from './mirror/derive.js'
import { legacyColumnLengths } from './mirror/lengths.js'
import { loadStoredChild, loadTargetFamily } from './mirror/load.js'
import { affectedChildIdsForFamily } from './mirror/affected.js'
import { writeMirror } from './mirror/write.js'
import { noParentSlot, parentSlotCount } from './write/household.js'
import { ADDITIONAL_MIRROR_COLUMNS, CHILDREN_MIRROR_COLUMNS } from './mirror/types.js'

const CHILD_COLUMNS = new Set<string>(CHILDREN_MIRROR_COLUMNS)

interface ChildLock extends RowDataPacket {
  id: number
  familyId: number | null
  status: string
}

interface MemberLock extends RowDataPacket {
  id: number
}

interface RightsLock extends RowDataPacket {
  id: number
  memberId: number
  receivesNotifications: number
  notifyMethod: 'sms' | 'voice' | 'both'
  mayCollect: number
  collectFrom: string | null
  collectTo: string | null
  isEmergency: number
  isPaymentResponsible: number
}

export async function previewLink(pool: Pool, familyId: number, childId: number): Promise<LinkPreview> {
  const child = await loadStoredChild(pool, childId)
  if (child === null || child.status === 'trash') {
    throw new ApiError(404, 'NOT_FOUND', 'Child not found')
  }
  const family = await loadTargetFamily(pool, familyId, childId)
  if (family === null) {
    throw new ApiError(404, 'NOT_FOUND', 'Family not found')
  }
  const after = deriveLegacyValues({ id: childId }, family)
  const lengths = await legacyColumnLengths(pool)
  const columns = [...CHILDREN_MIRROR_COLUMNS, ...ADDITIONAL_MIRROR_COLUMNS].map((column) => {
    const today = legacyColumnValue(child.stored, column)
    const derived = legacyColumnValue(after, column)
    const inChildren = CHILD_COLUMNS.has(column)
    // Exactly what link will store: '' stays '' where the derived empty value is NULL, and the reverse.
    const next = valueAfterMirror(today, derived, !inChildren && !child.hasAdditional)
    const max = lengths.get(column)
    return {
      column,
      table: inChildren ? ('children' as const) : ('children_additional_information' as const),
      today,
      after: next,
      changed: !sameLegacyValue(today, derived),
      tooLong: typeof derived === 'string' && max !== undefined && characterLength(derived) > max,
    }
  })
  return {
    childId,
    familyId,
    currentFamilyId: child.familyId,
    columns,
  }
}

export async function linkChild(
  pool: Pool,
  staffId: number,
  familyId: number,
  childId: number,
  options: { allowEmptyParents?: boolean } = {},
): Promise<LinkResult> {
  const affected = await withStaffTransaction(pool, staffId, async (connection) => {
    const child = await lockChildForLink(connection, familyId, childId)
    const members = await activeMemberIds(connection, familyId)
    if (members.length === 0) {
      throw new ApiError(409, 'NO_MEMBERS', 'This family has no active member.')
    }
    if (child.familyId !== null && child.familyId !== familyId) {
      throw new ApiError(409, 'ALREADY_LINKED', 'This child is linked to another family.', { familyId: child.familyId })
    }
    // A relink to the same family changes nothing, so only a new link is refused.
    if (child.familyId !== familyId && options.allowEmptyParents !== true && (await parentSlotCount(connection, familyId)) === 0) {
      throw noParentSlot([childId])
    }
    await connection.query('SET @family_mirror = 1')
    if (child.familyId !== familyId) {
      await connection.query(`UPDATE children SET family_id = ? WHERE id = ?`, [familyId, childId])
      await writeAudit(connection, staffId, [
        {
          table: 'children',
          id: childId,
          action: 'update',
          column: 'family_id',
          oldValue: auditValue(child.familyId),
          newValue: auditValue(familyId),
        },
      ])
    }
    return writeMirror(connection, [childId])
  })
  return { childId, familyId, affected_child_ids: affected }
}

export async function unlinkChild(pool: Pool, staffId: number, childId: number): Promise<UnlinkResult> {
  await withStaffTransaction(pool, staffId, async (connection) => {
    const peeked = await readChild(connection, childId)
    if (peeked?.familyId !== null && peeked?.familyId !== undefined) {
      await lockFamilies(connection, [peeked.familyId])
    }
    const child = await readChild(connection, childId, true)
    if (child === null || child.status === 'trash') {
      throw new ApiError(404, 'NOT_FOUND', 'Child not found')
    }
    if (child.familyId === null) {
      throw new ApiError(404, 'NOT_FOUND', 'This child is not linked')
    }
    if (peeked?.familyId !== child.familyId) {
      await lockFamilies(connection, [child.familyId])
    }
    await connection.query('SET @family_mirror = 1')
    await connection.query(`UPDATE children SET family_id = NULL WHERE id = ?`, [childId])
    await writeAudit(connection, staffId, [
      {
        table: 'children',
        id: childId,
        action: 'update',
        column: 'family_id',
        oldValue: auditValue(child.familyId),
        newValue: null,
      },
    ])
  })
  return { childId, familyId: null, affected_child_ids: [] }
}

export async function replaceRights(
  pool: Pool,
  staffId: number,
  familyId: number,
  childId: number,
  body: ReplaceRightsBody,
): Promise<RightsResult> {
  return withStaffTransaction(pool, staffId, async (connection) => {
    await lockFamilies(connection, [familyId])
    await requireActiveFamily(connection, familyId)
    await requireChildOf(connection, familyId, childId)
    const members = await activeMemberIds(connection, familyId)
    assertMemberSet(members, body.rights.map((row) => row.memberId))
    for (const row of body.rights) {
      assertCollectRange(row.collectFrom, row.collectTo)
    }
    const existing = members.length === 0
      ? []
      : await rows<RightsLock>(
          connection,
          `SELECT id, member_id AS memberId, receives_notifications AS receivesNotifications, notify_method AS notifyMethod,
                  may_collect AS mayCollect, collect_from AS collectFrom, collect_to AS collectTo,
                  is_emergency AS isEmergency, is_payment_responsible AS isPaymentResponsible
           FROM family_member_children
           WHERE child_id = ? AND member_id IN (${members.map(() => '?').join(', ')})
           ORDER BY member_id
           FOR UPDATE`,
          [childId, ...members],
        )
    const byMember = new Map(existing.map((row) => [Number(row.memberId), row]))
    const changes: AuditChange[] = []
    for (const row of body.rights) {
      const next = rightsValues(row)
      const current = byMember.get(row.memberId)
      if (current === undefined) {
        const id = await insertId(
          connection,
          `INSERT INTO family_member_children
             (member_id, child_id, receives_notifications, notify_method, may_collect, collect_from, collect_to,
              is_emergency, is_payment_responsible)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            row.memberId,
            childId,
            next.receives_notifications,
            next.notify_method,
            next.may_collect,
            next.collect_from,
            next.collect_to,
            next.is_emergency,
            next.is_payment_responsible,
          ],
        )
        changes.push(...columnChanges('family_member_children', id, 'insert', {}, auditRights(next)))
      } else {
        const rowChanges = columnChanges(
          'family_member_children',
          current.id,
          'update',
          auditRights(rightsFromRow(current)),
          auditRights(next),
        )
        if (rowChanges.length > 0) {
          await connection.query(
            `UPDATE family_member_children
             SET receives_notifications = ?, notify_method = ?, may_collect = ?, collect_from = ?, collect_to = ?,
                 is_emergency = ?, is_payment_responsible = ?
             WHERE id = ?`,
            [
              next.receives_notifications,
              next.notify_method,
              next.may_collect,
              next.collect_from,
              next.collect_to,
              next.is_emergency,
              next.is_payment_responsible,
              current.id,
            ],
          )
          changes.push(...rowChanges)
        }
      }
    }
    await writeAudit(connection, staffId, changes)
    const affected = await writeMirror(connection, await affectedChildIdsForFamily(connection, familyId))
    const rights = await readRights(connection, familyId, childId)
    return { familyId, childId, rights, affected_child_ids: affected }
  })
}

async function lockChildForLink(connection: PoolConnection, familyId: number, childId: number): Promise<ChildLock> {
  const peeked = await readChild(connection, childId)
  const ids = [familyId]
  if (peeked?.familyId !== null && peeked?.familyId !== undefined) {
    ids.push(peeked.familyId)
  }
  await lockFamilies(connection, ids)
  const child = await readChild(connection, childId, true)
  if (child === null || child.status === 'trash') {
    throw new ApiError(404, 'NOT_FOUND', 'Child not found')
  }
  if (child.familyId !== null && !ids.includes(child.familyId)) {
    await lockFamilies(connection, [child.familyId])
  }
  const family = await rows<RowDataPacket>(
    connection,
    `SELECT id, status FROM families WHERE id = ?`,
    [familyId],
  )
  if (family[0] === undefined || family[0]['status'] !== 'active') {
    throw new ApiError(404, 'NOT_FOUND', 'Family not found')
  }
  return child
}

async function readChild(connection: PoolConnection, childId: number, lock = false): Promise<ChildLock | null> {
  const found = await rows<ChildLock>(
    connection,
    `SELECT id, family_id AS familyId, status FROM children WHERE id = ?${lock ? ' FOR UPDATE' : ''}`,
    [childId],
  )
  const child = found[0]
  if (child === undefined) {
    return null
  }
  return {
    ...child,
    id: Number(child.id),
    familyId: child.familyId === null ? null : Number(child.familyId),
    status: String(child.status),
  }
}

async function requireActiveFamily(connection: PoolConnection, familyId: number): Promise<void> {
  const found = await rows<RowDataPacket>(connection, `SELECT status FROM families WHERE id = ?`, [familyId])
  if (found[0] === undefined || found[0]['status'] !== 'active') {
    throw new ApiError(404, 'NOT_FOUND', 'Family not found')
  }
}

/** Rights are set for a child of this family, or for an unlinked child before it is linked here. */
async function requireChildOf(connection: PoolConnection, familyId: number, childId: number): Promise<void> {
  const child = await readChild(connection, childId, true)
  if (child === null || child.status === 'trash') {
    throw new ApiError(404, 'NOT_FOUND', 'Child not found')
  }
  if (child.familyId !== null && child.familyId !== familyId) {
    throw new ApiError(409, 'ALREADY_LINKED', 'This child is linked to another family.', { familyId: child.familyId })
  }
}

async function activeMemberIds(connection: PoolConnection, familyId: number): Promise<number[]> {
  const found = await rows<MemberLock>(
    connection,
    `SELECT m.id
     FROM family_members AS m
     INNER JOIN family_contacts AS c ON c.id = m.family_contact_id AND c.status = 'active'
     WHERE m.family_id = ? AND m.status = 'active'
     ORDER BY m.id
     FOR UPDATE`,
    [familyId],
  )
  return found.map((row) => Number(row.id))
}

function assertMemberSet(expected: readonly number[], got: readonly number[]): void {
  const expectedSet = new Set(expected)
  const gotSet = new Set(got)
  if (gotSet.size !== got.length || expectedSet.size !== gotSet.size || expected.some((id) => !gotSet.has(id))) {
    throw new ApiError(400, 'VALIDATION', 'Send one rights row for each active member of this family.')
  }
}

function assertCollectRange(from: string | null, to: string | null): void {
  if (from !== null && !isDate(from)) {
    throw new ApiError(400, 'VALIDATION', 'collectFrom must be a date.')
  }
  if (to !== null && !isDate(to)) {
    throw new ApiError(400, 'VALIDATION', 'collectTo must be a date.')
  }
  if (from !== null && to !== null && to < from) {
    throw new ApiError(400, 'VALIDATION', 'collectTo must be on or after collectFrom.')
  }
}

function isDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false
  }
  const [year, month, day] = value.split('-').map((part) => Number(part))
  if (year === undefined || month === undefined || day === undefined) {
    return false
  }
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

interface RightsValues {
  receives_notifications: number
  notify_method: 'sms' | 'voice' | 'both'
  may_collect: number
  collect_from: string | null
  collect_to: string | null
  is_emergency: number
  is_payment_responsible: number
}

function rightsValues(row: ReplaceRightsBody['rights'][number]): RightsValues {
  return {
    receives_notifications: row.receivesNotifications ? 1 : 0,
    notify_method: row.notifyMethod,
    may_collect: row.mayCollect ? 1 : 0,
    collect_from: row.collectFrom,
    collect_to: row.collectTo,
    is_emergency: row.isEmergency ? 1 : 0,
    is_payment_responsible: row.isPaymentResponsible ? 1 : 0,
  }
}

function rightsFromRow(row: RightsLock): RightsValues {
  return {
    receives_notifications: Number(row.receivesNotifications) === 1 ? 1 : 0,
    notify_method: row.notifyMethod,
    may_collect: Number(row.mayCollect) === 1 ? 1 : 0,
    collect_from: row.collectFrom === null ? null : String(row.collectFrom).slice(0, 10),
    collect_to: row.collectTo === null ? null : String(row.collectTo).slice(0, 10),
    is_emergency: Number(row.isEmergency) === 1 ? 1 : 0,
    is_payment_responsible: Number(row.isPaymentResponsible) === 1 ? 1 : 0,
  }
}

function auditRights(row: RightsValues): Record<string, string | null> {
  return {
    receives_notifications: auditValue(row.receives_notifications),
    notify_method: row.notify_method,
    may_collect: auditValue(row.may_collect),
    collect_from: row.collect_from,
    collect_to: row.collect_to,
    is_emergency: auditValue(row.is_emergency),
    is_payment_responsible: auditValue(row.is_payment_responsible),
  }
}

async function readRights(connection: PoolConnection, familyId: number, childId: number): Promise<RightsResult['rights']> {
  const found = await rows<RightsLock>(
    connection,
    `SELECT r.id, r.member_id AS memberId, r.receives_notifications AS receivesNotifications,
            r.notify_method AS notifyMethod, r.may_collect AS mayCollect, r.collect_from AS collectFrom,
            r.collect_to AS collectTo, r.is_emergency AS isEmergency, r.is_payment_responsible AS isPaymentResponsible
     FROM family_member_children AS r
     INNER JOIN family_members AS m ON m.id = r.member_id AND m.family_id = ? AND m.status = 'active'
     INNER JOIN family_contacts AS c ON c.id = m.family_contact_id AND c.status = 'active'
     WHERE r.child_id = ?
     ORDER BY r.member_id`,
    [familyId, childId],
  )
  return found.map((row) => {
    const values = rightsFromRow(row)
    return {
      id: Number(row.id),
      memberId: Number(row.memberId),
      childId,
      receivesNotifications: values.receives_notifications === 1,
      notifyMethod: values.notify_method,
      mayCollect: values.may_collect === 1,
      collectFrom: values.collect_from,
      collectTo: values.collect_to,
      isEmergency: values.is_emergency === 1,
      isPaymentResponsible: values.is_payment_responsible === 1,
    }
  })
}
