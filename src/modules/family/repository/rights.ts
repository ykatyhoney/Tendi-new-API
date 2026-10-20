// SQL for family_member_children, one child at a time. No business rules here.
// A statement here must not read children or children_additional_information: the mirror
// triggers write them, which would fail with error 1442 (docs/CONTEXT.md "Mirror and audit").

import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { Queryable } from '../db.ts';
import type { RightRowDb } from './families.ts';

/** The columns PUT /families/:id/children/:childId/rights sets. */
export interface RightValues {
  is_primary: number;
  receives_notifications: number;
  notify_method: string;
  may_collect: number;
  collect_from: string | null;
  collect_to: string | null;
  is_emergency: number;
  is_payment_responsible: number;
}

export const RIGHT_COLUMNS = [
  'is_primary',
  'receives_notifications',
  'notify_method',
  'may_collect',
  'collect_from',
  'collect_to',
  'is_emergency',
  'is_payment_responsible',
] as const satisfies readonly (keyof RightValues)[];

const SELECT_RIGHTS = `SELECT fmc.id, fmc.member_id, fmc.child_id, ${RIGHT_COLUMNS.map((c) => `fmc.${c}`).join(', ')}`;

/** The child's rights rows of every member of the family (any member status), locked. */
export async function rightsOfChildForUpdate(
  db: Queryable,
  familyId: number,
  childId: number,
): Promise<(RightRowDb & { member_status: 'active' | 'trash' })[]> {
  const [rows] = await db.query<RowDataPacket[]>(
    `${SELECT_RIGHTS}, fm.status AS member_status
       FROM family_member_children fmc
       JOIN family_members fm ON fm.id = fmc.member_id
      WHERE fm.family_id = ? AND fmc.child_id = ?
      ORDER BY fmc.id FOR UPDATE`,
    [familyId, childId],
  );
  return rows as (RightRowDb & { member_status: 'active' | 'trash' })[];
}

/** The child's rights rows of the family's active members, by member sort_order. */
export async function rightsOfChild(db: Queryable, familyId: number, childId: number): Promise<RightRowDb[]> {
  const [rows] = await db.query<RowDataPacket[]>(
    `${SELECT_RIGHTS}
       FROM family_member_children fmc
       JOIN family_members fm ON fm.id = fmc.member_id AND fm.status = 'active'
      WHERE fm.family_id = ? AND fmc.child_id = ?
      ORDER BY fm.sort_order, fm.id`,
    [familyId, childId],
  );
  return rows as RightRowDb[];
}

/** Of `memberIds`, those that are active members of the family, locked. */
export async function activeMemberIds(db: Queryable, familyId: number, memberIds: number[]): Promise<Set<number>> {
  if (memberIds.length === 0) return new Set();
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT id FROM family_members WHERE family_id = ? AND status = 'active' AND id IN (?) ORDER BY id FOR UPDATE`,
    [familyId, memberIds],
  );
  return new Set(rows.map((r) => r.id as number));
}

export async function insertRight(
  db: Queryable,
  memberId: number,
  childId: number,
  values: RightValues,
): Promise<number> {
  const [result] = await db.query<ResultSetHeader>(
    `INSERT INTO family_member_children (member_id, child_id, ${RIGHT_COLUMNS.join(', ')})
     VALUES (?, ?, ${RIGHT_COLUMNS.map(() => '?').join(', ')})`,
    [memberId, childId, ...RIGHT_COLUMNS.map((c) => values[c])],
  );
  return result.insertId;
}

export async function updateRight(db: Queryable, id: number, changes: Partial<RightValues>): Promise<void> {
  const columns = Object.keys(changes) as (keyof RightValues)[];
  if (columns.length === 0) return;
  await db.query(`UPDATE family_member_children SET ${columns.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, [
    ...columns.map((c) => changes[c]),
    id,
  ]);
}

export async function deleteRights(db: Queryable, ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await db.query('DELETE FROM family_member_children WHERE id IN (?)', [ids]);
}
