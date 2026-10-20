// SQL for children (read, and its one writable column family_id) and for what the link preview
// checks in the family tables. No business rules here.

import type { RowDataPacket } from 'mysql2/promise';
import type { Queryable } from '../db.ts';
import { likeEscape } from './families.ts';

export interface ChildRow {
  id: number;
  fname: string;
  lname: string;
  family_id: number | null;
}

/** The child, or null. `forUpdate` locks the row. */
export async function findChild(db: Queryable, id: number, forUpdate = false): Promise<ChildRow | null> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT id, fname, lname, family_id FROM children WHERE id = ?${forUpdate ? ' FOR UPDATE' : ''}`,
    [id],
  );
  return (rows[0] as ChildRow | undefined) ?? null;
}

/**
 * Sets children.family_id. Setting a family fires trg_children_family_bu / _au, which mirror the
 * 28 legacy columns in this statement; NULL leaves them as they are.
 */
export async function setChildFamily(db: Queryable, childId: number, familyId: number | null): Promise<void> {
  await db.query('UPDATE children SET family_id = ? WHERE id = ?', [familyId, childId]);
}

export interface ParentSlot {
  slot: 'father' | 'mother';
  member_id: number;
  name: string;
  has_primary_phone: number;
}

/**
 * The members filling the father and mother slots, chosen as sp_family_mirror_values chooses them
 * (migration family_022): an active member and person with relationship father (else
 * step_father), lowest sort_order, then lowest id; likewise mother / step_mother.
 */
export async function parentSlots(db: Queryable, familyId: number): Promise<ParentSlot[]> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT slot, member_id, name, has_primary_phone FROM (
       SELECT IF(fm.relationship IN ('father', 'step_father'), 'father', 'mother') AS slot,
              fm.id AS member_id,
              TRIM(CONCAT(p.fname, ' ', p.lname)) AS name,
              EXISTS (SELECT 1 FROM people_phones pp WHERE pp.person_id = p.id AND pp.is_primary = 1) AS has_primary_phone,
              ROW_NUMBER() OVER (
                PARTITION BY fm.relationship IN ('father', 'step_father')
                ORDER BY fm.relationship NOT IN ('father', 'mother'), fm.sort_order, fm.id
              ) AS n
         FROM family_members fm
         JOIN people p ON p.id = fm.person_id
        WHERE fm.family_id = ? AND fm.status = 'active' AND p.status = 'active'
          AND fm.relationship IN ('father', 'step_father', 'mother', 'step_mother')
     ) ranked
     WHERE n = 1
     ORDER BY slot`,
    [familyId],
  );
  return rows as ParentSlot[];
}

/** Counts of the child's rights rows of the family's active members: all, and payment-responsible. */
export async function rightsCounts(
  db: Queryable,
  familyId: number,
  childId: number,
): Promise<{ rights: number; payment_responsible: number }> {
  const [[row]] = await db.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS rights, COALESCE(SUM(fmc.is_payment_responsible = 1), 0) AS payment_responsible
       FROM family_member_children fmc
       JOIN family_members fm ON fm.id = fmc.member_id AND fm.status = 'active'
      WHERE fm.family_id = ? AND fmc.child_id = ?`,
    [familyId, childId],
  );
  return { rights: Number(row.rights), payment_responsible: Number(row.payment_responsible) };
}

export interface ChildSummaryRow {
  id: number;
  fname: string;
  lname: string;
  status: 'active' | 'inactive';
  class_id: number;
  class_name: string | null;
  family_id: number | null;
  family_name: string | null;
}

/** What GET /children searches for (built by service/children.ts from `q`). */
export type ChildSearch = { id: number } | { name: string };

/**
 * Children that are not trashed, matching an exact id or a name anywhere in fname, lname,
 * "fname lname" or "lname fname" (a scan: 753 rows in the 2026-09-24 dump). Active first, then
 * by last name, first name and id. family_name is the linked family's name, whatever its status.
 */
export async function searchChildren(
  db: Queryable,
  search: ChildSearch,
  limit: number,
  offset: number,
): Promise<{ rows: ChildSummaryRow[]; total: number }> {
  let where: string;
  let params: unknown[];
  if ('id' in search) {
    where = 'c.id = ?';
    params = [search.id];
  } else {
    const like = `%${likeEscape(search.name)}%`;
    where = `(c.fname LIKE ? OR c.lname LIKE ? OR CONCAT(c.fname, ' ', c.lname) LIKE ? OR CONCAT(c.lname, ' ', c.fname) LIKE ?)`;
    params = [like, like, like, like];
  }
  const [[count]] = await db.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS total FROM children c WHERE c.status <> 'trash' AND ${where}`,
    params,
  );
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT c.id, c.fname, c.lname, c.status, c.class AS class_id, cl.name AS class_name,
            c.family_id, f.name AS family_name
       FROM children c
       LEFT JOIN classes cl ON cl.id = c.class
       LEFT JOIN families f ON f.id = c.family_id
      WHERE c.status <> 'trash' AND ${where}
      ORDER BY c.status = 'active' DESC, c.lname, c.fname, c.id
      LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  return { rows: rows as ChildSummaryRow[], total: Number(count.total) };
}
