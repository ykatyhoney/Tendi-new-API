import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import { ApiError } from '../../../../lib/api-error.js'
import { rows } from '../../repositories/query.js'
import { auditValue, columnChanges, writeAudit, type AuditChange } from './audit.js'

/*
 * Household rules shared by the member and link writes. Callers hold the family row lock (lockFamilies), which
 * keeps two saves of one household in order, so these reads need no locks of their own.
 */

export interface ActiveMember {
  id: number
  isPrimary: boolean
  slot: 'father' | 'mother' | null
}

interface ActiveMemberRow extends RowDataPacket {
  id: number
  isPrimary: number
  slot: string | null
}

/**
 * Active members whose contact is active, in main-contact order: parent-slot members first (by slot_rank),
 * then sort_order, then id.
 */
export async function activeMembers(connection: PoolConnection, familyId: number): Promise<ActiveMember[]> {
  const found = await rows<ActiveMemberRow>(
    connection,
    `SELECT m.id, m.is_primary + 0 AS isPrimary, rt.parent_slot AS slot
     FROM family_members AS m
     INNER JOIN family_contacts AS c ON c.id = m.family_contact_id AND c.status = 'active'
     INNER JOIN relationship_types AS rt ON rt.code = m.relationship
     WHERE m.family_id = ? AND m.status = 'active'
     ORDER BY rt.parent_slot IS NULL, rt.slot_rank, m.sort_order, m.id`,
    [familyId],
  )
  return found.map((row) => ({
    id: Number(row.id),
    isPrimary: Number(row.isPrimary) === 1,
    slot: row.slot === 'father' || row.slot === 'mother' ? row.slot : null,
  }))
}

/** Active members that fill the father or mother slot. */
export async function parentSlotCount(connection: PoolConnection, familyId: number): Promise<number> {
  return (await activeMembers(connection, familyId)).filter((member) => member.slot !== null).length
}

export function noParentSlot(childIds: readonly number[]): ApiError {
  return new ApiError(
    409,
    'NO_PARENT_SLOT',
    'This would leave the linked children with no father or mother. Send allowEmptyParents: true to save anyway.',
    { childIds },
  )
}

/**
 * After a member removal or relationship change: refuse when it emptied both parent slots of a family with
 * linked children, unless the request allows it. A household whose slots were already empty is not refused.
 */
export async function refuseEmptyParents(
  connection: PoolConnection,
  familyId: number,
  linkedChildIds: readonly number[],
  slotsBefore: number,
  allowEmptyParents: boolean,
): Promise<void> {
  if (allowEmptyParents || linkedChildIds.length === 0 || slotsBefore === 0) {
    return
  }
  if ((await parentSlotCount(connection, familyId)) === 0) {
    throw noParentSlot(linkedChildIds)
  }
}

/**
 * A household with active members has exactly one main contact. When none is main, the first member in
 * main-contact order is made main, skipping `avoidMemberId` when another member exists. Audited.
 */
export async function ensureMainContact(
  connection: PoolConnection,
  staffId: number,
  familyId: number,
  avoidMemberId?: number,
): Promise<void> {
  const members = await activeMembers(connection, familyId)
  if (members.length === 0 || members.some((member) => member.isPrimary)) {
    return
  }
  const next = members.find((member) => member.id !== avoidMemberId) ?? members[0]
  if (next === undefined) {
    return
  }
  await connection.query(`UPDATE family_members SET is_primary = 1 WHERE id = ?`, [next.id])
  await writeAudit(connection, staffId, [
    { table: 'family_members', id: next.id, action: 'update', column: 'is_primary', oldValue: '0', newValue: '1' },
  ])
}

interface RightsRow extends RowDataPacket {
  id: number
  childId: number
  receivesNotifications: number
  notifyMethod: string | null
  mayCollect: number
  collectFrom: string | null
  collectTo: string | null
  isEmergency: number
  isPaymentResponsible: number
}

/** A removed member's rights for every child are deleted, so a member who is added back starts with none. Audited. */
export async function deleteMemberRights(connection: PoolConnection, staffId: number, memberId: number): Promise<void> {
  const found = await rows<RightsRow>(
    connection,
    `SELECT id, child_id AS childId, receives_notifications + 0 AS receivesNotifications, notify_method AS notifyMethod,
            may_collect + 0 AS mayCollect, collect_from AS collectFrom, collect_to AS collectTo,
            is_emergency + 0 AS isEmergency, is_payment_responsible + 0 AS isPaymentResponsible
     FROM family_member_children
     WHERE member_id = ?
     ORDER BY id
     FOR UPDATE`,
    [memberId],
  )
  if (found.length === 0) {
    return
  }
  await connection.query(`DELETE FROM family_member_children WHERE member_id = ?`, [memberId])
  const changes: AuditChange[] = []
  for (const row of found) {
    const before = {
      member_id: auditValue(memberId),
      child_id: auditValue(Number(row.childId)),
      receives_notifications: auditValue(Number(row.receivesNotifications)),
      notify_method: row.notifyMethod === null ? null : String(row.notifyMethod),
      may_collect: auditValue(Number(row.mayCollect)),
      collect_from: row.collectFrom === null ? null : String(row.collectFrom).slice(0, 10),
      collect_to: row.collectTo === null ? null : String(row.collectTo).slice(0, 10),
      is_emergency: auditValue(Number(row.isEmergency)),
      is_payment_responsible: auditValue(Number(row.isPaymentResponsible)),
    }
    const blank = Object.fromEntries(Object.keys(before).map((column) => [column, null]))
    changes.push(...columnChanges('family_member_children', Number(row.id), 'delete', before, blank))
  }
  await writeAudit(connection, staffId, changes)
}
