import type { Pool, RowDataPacket } from 'mysql2/promise'
import { placeholders, rows } from './query.js'

export interface ChildRow extends RowDataPacket {
  id: number
  familyId: number | null
  fname: string
  lname: string
  classId: number
  status: string
}

export interface RightsRow extends RowDataPacket {
  id: number
  memberId: number
  childId: number
  receivesNotifications: number
  notifyMethod: 'sms' | 'voice' | 'both'
  mayCollect: number
  collectFrom: string | null
  collectTo: string | null
  isEmergency: number
  isPaymentResponsible: number
}

export async function listChildren(db: Pool, familyIds: readonly number[]): Promise<ChildRow[]> {
  if (familyIds.length === 0) {
    return []
  }
  return rows<ChildRow>(
    db,
    `SELECT id, family_id AS familyId, fname, lname, \`class\` AS classId, status
     FROM children
     WHERE status <> 'trash' AND family_id IN (${placeholders(familyIds.length)})
     ORDER BY family_id, lname, fname, id`,
    familyIds,
  )
}

export async function findChild(db: Pool, childId: number): Promise<ChildRow | null> {
  const found = await rows<ChildRow>(
    db,
    `SELECT id, family_id AS familyId, fname, lname, \`class\` AS classId, status
     FROM children
     WHERE id = ?`,
    [childId],
  )
  return found[0] ?? null
}

/** Active family with the most rights rows for this child, then the lowest id. */
export async function draftFamilyId(db: Pool, childId: number): Promise<number | null> {
  const found = await rows<RowDataPacket>(
    db,
    `SELECT f.id AS familyId
     FROM family_member_children AS r
     INNER JOIN family_members AS m ON m.id = r.member_id AND m.status = 'active'
     INNER JOIN families AS f ON f.id = m.family_id AND f.status = 'active'
     WHERE r.child_id = ?
     GROUP BY f.id
     ORDER BY COUNT(*) DESC, f.id
     LIMIT 1`,
    [childId],
  )
  const id = found[0]?.['familyId']
  return id === undefined ? null : Number(id)
}

export async function listRights(db: Pool, memberIds: readonly number[]): Promise<RightsRow[]> {
  if (memberIds.length === 0) {
    return []
  }
  return rows<RightsRow>(
    db,
    `SELECT id, member_id AS memberId, child_id AS childId,
            receives_notifications AS receivesNotifications, notify_method AS notifyMethod,
            may_collect AS mayCollect, collect_from AS collectFrom, collect_to AS collectTo,
            is_emergency AS isEmergency, is_payment_responsible AS isPaymentResponsible
     FROM family_member_children
     WHERE member_id IN (${placeholders(memberIds.length)})
     ORDER BY member_id, child_id`,
    memberIds,
  )
}
