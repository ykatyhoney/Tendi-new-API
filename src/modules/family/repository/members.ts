// SQL for family_members. No business rules here.

import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { Queryable } from '../db.ts';

export interface MembershipRow {
  id: number;
  family_id: number;
  person_id: number;
  relationship: string;
  is_primary: number;
  sort_order: number;
  status: 'active' | 'trash';
}

export type MemberValues = Pick<MembershipRow, 'relationship' | 'is_primary' | 'sort_order' | 'status'>;

const MEMBER_COLUMNS = 'id, family_id, person_id, relationship, is_primary, sort_order, status';

/** The member of this family, any status, or null. `forUpdate` locks it. */
export async function findMember(
  db: Queryable,
  familyId: number,
  memberId: number,
  forUpdate = false,
): Promise<MembershipRow | null> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${MEMBER_COLUMNS} FROM family_members WHERE id = ? AND family_id = ?${forUpdate ? ' FOR UPDATE' : ''}`,
    [memberId, familyId],
  );
  return (rows[0] as MembershipRow | undefined) ?? null;
}

/** The person's membership of the family (uniq_fm: at most one, any status), locked. */
export async function findMembershipForUpdate(
  db: Queryable,
  familyId: number,
  personId: number,
): Promise<MembershipRow | null> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${MEMBER_COLUMNS} FROM family_members WHERE family_id = ? AND person_id = ? FOR UPDATE`,
    [familyId, personId],
  );
  return (rows[0] as MembershipRow | undefined) ?? null;
}

export async function insertMember(
  db: Queryable,
  member: { family_id: number; person_id: number; relationship: string; is_primary: boolean; sort_order: number },
): Promise<number> {
  const [result] = await db.query<ResultSetHeader>(
    `INSERT INTO family_members (family_id, person_id, relationship, is_primary, sort_order, status)
     VALUES (?, ?, ?, ?, ?, 'active')`,
    [member.family_id, member.person_id, member.relationship, member.is_primary, member.sort_order],
  );
  return result.insertId;
}

export async function updateMember(db: Queryable, id: number, changes: Partial<MemberValues>): Promise<void> {
  const columns = Object.keys(changes) as (keyof MemberValues)[];
  if (columns.length === 0) return;
  await db.query(`UPDATE family_members SET ${columns.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, [
    ...columns.map((c) => changes[c]),
    id,
  ]);
}

/** Active primary members of the family other than `exceptId`, locked. */
export async function otherPrimaryMembers(db: Queryable, familyId: number, exceptId: number): Promise<number[]> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT id FROM family_members
      WHERE family_id = ? AND id <> ? AND status = 'active' AND is_primary = 1
      ORDER BY id FOR UPDATE`,
    [familyId, exceptId],
  );
  return rows.map((r) => r.id);
}

/** The rights columns a reset clears (family_member_children). */
export interface RightFlags {
  receives_notifications: number;
  may_collect: number;
  collect_from: string | null;
  collect_to: string | null;
  is_emergency: number;
  is_payment_responsible: number;
}

/** The member's rights rows, every child, locked. */
export async function rightsOfMemberForUpdate(
  db: Queryable,
  memberId: number,
): Promise<(RightFlags & { id: number; child_id: number })[]> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT id, child_id, receives_notifications, may_collect, collect_from, collect_to, is_emergency,
            is_payment_responsible
       FROM family_member_children WHERE member_id = ? ORDER BY child_id, id FOR UPDATE`,
    [memberId],
  );
  return rows as (RightFlags & { id: number; child_id: number })[];
}

export async function updateRights(db: Queryable, ids: number[], values: RightFlags): Promise<void> {
  if (ids.length === 0) return;
  const columns = Object.keys(values) as (keyof RightFlags)[];
  await db.query(`UPDATE family_member_children SET ${columns.map((c) => `${c} = ?`).join(', ')} WHERE id IN (?)`, [
    ...columns.map((c) => values[c]),
    ids,
  ]);
}
