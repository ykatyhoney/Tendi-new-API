// SQL for families and what hangs off them (members, people, phones, addresses, children, rights).
// Reads take a Queryable (pool, or the write's transaction connection); no business rules here.

import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { Queryable } from '../db.ts';

export interface FamilyRow {
  id: number;
  name: string;
  household_phone: string;
  status: 'active' | 'trash';
  created_at: string;
  updated_at: string;
}

const FAMILY_COLUMNS = 'f.id, f.name, f.household_phone, f.status, f.created_at, f.updated_at';

/** `text` for a LIKE pattern, with % _ and \ matching literally. */
const likeEscape = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`);

/** What GET /families searches for (built by service/families.ts from `q`). */
export type FamilySearch =
  | { phone: string } // exactly these 10 normalized digits
  | { phoneSuffix: string } // 4-9 digits: the end of a normalized phone
  | { name: string } // anywhere in a name (the collations are case-insensitive)
  | null; // every active family

/**
 * The ids of active families matching a search, as a UNION of a families lookup and a people lookup:
 *  - phone: equality on people_phones.phone_normalized (idx_pp_norm) and
 *    families.household_phone_normalized (idx_families_household_norm);
 *  - phoneSuffix: the same columns, LIKE '%digits' (a scan);
 *  - name: families.name, or an active member's fname, lname or legacy_full_name, LIKE '%text%'
 *    (a scan; see "Search" in docs/CONTEXT.md for when to revisit).
 * Only active families, members and people count.
 */
export function matchingFamilyIds(search: FamilySearch): { sql: string; params: unknown[] } {
  if (search === null) {
    return { sql: "SELECT f.id FROM families f WHERE f.status = 'active'", params: [] };
  }
  if ('phone' in search || 'phoneSuffix' in search) {
    const [op, value] = 'phone' in search ? ['=', search.phone] : ['LIKE', `%${search.phoneSuffix}`];
    return {
      sql: `
        SELECT fm.family_id AS id
          FROM people_phones pp
          JOIN people p ON p.id = pp.person_id AND p.status = 'active'
          JOIN family_members fm ON fm.person_id = pp.person_id AND fm.status = 'active'
         WHERE pp.phone_normalized ${op} ?
        UNION
        SELECT f.id FROM families f WHERE f.household_phone_normalized ${op} ?`,
      params: [value, value],
    };
  }
  const like = `%${likeEscape(search.name)}%`;
  return {
    sql: `
      SELECT f.id FROM families f WHERE f.name LIKE ?
      UNION
      SELECT fm.family_id AS id
        FROM people p
        JOIN family_members fm ON fm.person_id = p.id AND fm.status = 'active'
       WHERE p.status = 'active' AND (p.fname LIKE ? OR p.lname LIKE ? OR p.legacy_full_name LIKE ?)`,
    params: [like, like, like, like],
  };
}

/** One page of matching active families (by name, then id) and the total count. */
export async function searchFamilies(
  db: Queryable,
  search: FamilySearch,
  limit: number,
  offset: number,
): Promise<{ rows: FamilyRow[]; total: number }> {
  const matched = matchingFamilyIds(search);
  const [[count]] = await db.query<RowDataPacket[]>(
    `WITH matched AS (${matched.sql})
     SELECT COUNT(*) AS total FROM families f JOIN matched m ON m.id = f.id WHERE f.status = 'active'`,
    matched.params,
  );
  const [rows] = await db.query<RowDataPacket[]>(
    `WITH matched AS (${matched.sql})
     SELECT ${FAMILY_COLUMNS}
       FROM families f JOIN matched m ON m.id = f.id
      WHERE f.status = 'active'
      ORDER BY f.name, f.id
      LIMIT ? OFFSET ?`,
    [...matched.params, limit, offset],
  );
  return { rows: rows as FamilyRow[], total: Number(count.total) };
}

/** The family row, or null. `forUpdate` locks it for the rest of the transaction. */
export async function findFamily(db: Queryable, id: number, forUpdate = false): Promise<FamilyRow | null> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${FAMILY_COLUMNS} FROM families f WHERE f.id = ?${forUpdate ? ' FOR UPDATE' : ''}`,
    [id],
  );
  return (rows[0] as FamilyRow | undefined) ?? null;
}

export async function insertFamily(
  db: Queryable,
  family: { name: string; household_phone: string },
  adminId: number,
): Promise<number> {
  const [result] = await db.query<ResultSetHeader>(
    `INSERT INTO families (name, household_phone, status, created_at, updated_at, created_by, updated_by)
     VALUES (?, ?, 'active', NOW(), NOW(), ?, ?)`,
    [family.name, family.household_phone, adminId, adminId],
  );
  return result.insertId;
}

export async function updateFamily(
  db: Queryable,
  id: number,
  changes: { name?: string; household_phone?: string },
  adminId: number,
): Promise<void> {
  const columns = Object.keys(changes) as (keyof typeof changes)[];
  await db.query(
    `UPDATE families SET ${columns.map((c) => `${c} = ?`).join(', ')}, updated_at = NOW(), updated_by = ? WHERE id = ?`,
    [...columns.map((c) => changes[c]), adminId, id],
  );
}

// --- What a family holds ----------------------------------------------------------------------

export interface MemberRow {
  id: number;
  family_id: number;
  person_id: number;
  relationship: string;
  is_primary: number;
  sort_order: number;
  status: 'active' | 'trash';
  fname: string;
  lname: string;
  legacy_full_name: string;
  hebrew_name: string;
  email: string;
  note: string | null;
  occupation: string;
  employer: string;
  person_status: 'active' | 'trash';
  person_created_at: string;
  person_updated_at: string;
}

/** Active members of the families, with their person, by family, sort_order, id. */
export async function membersOf(db: Queryable, familyIds: number[]): Promise<MemberRow[]> {
  if (familyIds.length === 0) return [];
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT fm.id, fm.family_id, fm.person_id, fm.relationship, fm.is_primary, fm.sort_order, fm.status,
            p.fname, p.lname, p.legacy_full_name, p.hebrew_name, p.email, p.note, p.occupation, p.employer,
            p.status AS person_status, p.created_at AS person_created_at, p.updated_at AS person_updated_at
       FROM family_members fm
       JOIN people p ON p.id = fm.person_id
      WHERE fm.family_id IN (?) AND fm.status = 'active'
      ORDER BY fm.family_id, fm.sort_order, fm.id`,
    [familyIds],
  );
  return rows as MemberRow[];
}

export interface PhoneRowDb {
  id: number;
  person_id: number;
  phone: string;
  phone_normalized: string;
  label: string;
  channel: string;
  is_primary: number;
  sort_order: number;
}

export async function phonesOf(db: Queryable, personIds: number[]): Promise<PhoneRowDb[]> {
  if (personIds.length === 0) return [];
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT id, person_id, phone, phone_normalized, label, channel, is_primary, sort_order
       FROM people_phones WHERE person_id IN (?) ORDER BY person_id, is_primary DESC, sort_order, id`,
    [personIds],
  );
  return rows as PhoneRowDb[];
}

export interface AddressRowDb {
  id: number;
  person_id: number;
  kind: string;
  line1: string;
  line2: string;
  city: string;
  state: string;
  zip: string;
}

export async function addressesOf(db: Queryable, personIds: number[]): Promise<AddressRowDb[]> {
  if (personIds.length === 0) return [];
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT id, person_id, kind, line1, line2, city, state, zip
       FROM people_addresses WHERE person_id IN (?) ORDER BY person_id, id`,
    [personIds],
  );
  return rows as AddressRowDb[];
}

export interface FamilyChildRow {
  family_id: number;
  id: number;
  fname: string;
  lname: string;
  class_id: number;
  class_name: string | null;
  linked: number;
}

/**
 * The children of the families: those linked (children.family_id) and those an active member has
 * rights rows for (backfill drafts before linking), each once per family with `linked` 1 or 0.
 * Linked first, then by lname, fname, id. class_name is NULL when children.class has no classes row
 * (class 0 = none).
 */
export async function childrenOfFamilies(db: Queryable, familyIds: number[]): Promise<FamilyChildRow[]> {
  if (familyIds.length === 0) return [];
  const [rows] = await db.query<RowDataPacket[]>(
    `WITH fc AS (
       SELECT c.family_id, c.id AS child_id FROM children c WHERE c.family_id IN (?)
       UNION
       SELECT fm.family_id, fmc.child_id
         FROM family_member_children fmc
         JOIN family_members fm ON fm.id = fmc.member_id AND fm.status = 'active'
        WHERE fm.family_id IN (?)
     )
     SELECT fc.family_id, c.id, c.fname, c.lname, c.class AS class_id, cl.name AS class_name,
            c.family_id <=> fc.family_id AS linked
       FROM fc
       JOIN children c ON c.id = fc.child_id
       LEFT JOIN classes cl ON cl.id = c.class
      ORDER BY fc.family_id, linked DESC, c.lname, c.fname, c.id`,
    [familyIds, familyIds],
  );
  return rows as FamilyChildRow[];
}

export interface RightRowDb {
  id: number;
  member_id: number;
  child_id: number;
  is_primary: number;
  receives_notifications: number;
  notify_method: string;
  may_collect: number;
  collect_from: string | null;
  collect_to: string | null;
  is_emergency: number;
  is_payment_responsible: number;
}

/** Rights rows of the family's active members, for any child. */
export async function rightsOfFamily(db: Queryable, familyId: number): Promise<RightRowDb[]> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT fmc.id, fmc.member_id, fmc.child_id, fmc.is_primary, fmc.receives_notifications, fmc.notify_method,
            fmc.may_collect, fmc.collect_from, fmc.collect_to, fmc.is_emergency, fmc.is_payment_responsible
       FROM family_member_children fmc
       JOIN family_members fm ON fm.id = fmc.member_id AND fm.status = 'active'
      WHERE fm.family_id = ?
      ORDER BY fmc.child_id, fm.sort_order, fm.id`,
    [familyId],
  );
  return rows as RightRowDb[];
}
