// SQL for people and their phone and address lists. No business rules here.

import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { Queryable } from '../db.ts';
import type { PhoneRow } from '../service/phones.ts';

export interface PersonRow {
  id: number;
  fname: string;
  lname: string;
  legacy_full_name: string;
  hebrew_name: string;
  email: string;
  note: string | null;
  occupation: string;
  employer: string;
  status: 'active' | 'trash';
  created_at: string;
  updated_at: string;
}

/** The people columns the API writes (besides status and the created / updated columns). */
export type PersonValues = Omit<PersonRow, 'id' | 'status' | 'created_at' | 'updated_at'>;

export interface AddressValues {
  kind: string;
  line1: string;
  line2: string;
  city: string;
  state: string;
  zip: string;
}

const PERSON_COLUMNS =
  'id, fname, lname, legacy_full_name, hebrew_name, email, note, occupation, employer, status, created_at, updated_at';

/** The person row, or null. `forUpdate` locks it for the rest of the transaction. */
export async function findPerson(db: Queryable, id: number, forUpdate = false): Promise<PersonRow | null> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${PERSON_COLUMNS} FROM people WHERE id = ?${forUpdate ? ' FOR UPDATE' : ''}`,
    [id],
  );
  return (rows[0] as PersonRow | undefined) ?? null;
}

export async function insertPerson(db: Queryable, person: PersonValues, adminId: number): Promise<number> {
  const [result] = await db.query<ResultSetHeader>(
    `INSERT INTO people (fname, lname, legacy_full_name, hebrew_name, email, note, occupation, employer, status,
                         created_at, updated_at, created_by, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', NOW(), NOW(), ?, ?)`,
    [
      person.fname,
      person.lname,
      person.legacy_full_name,
      person.hebrew_name,
      person.email,
      person.note,
      person.occupation,
      person.employer,
      adminId,
      adminId,
    ],
  );
  return result.insertId;
}

/** Sets the given columns (none: only updated_at / updated_by, e.g. after a phone list change). */
export async function updatePerson(
  db: Queryable,
  id: number,
  changes: Partial<PersonValues>,
  adminId: number,
): Promise<void> {
  const columns = Object.keys(changes) as (keyof PersonValues)[];
  await db.query(
    `UPDATE people SET ${columns.map((c) => `${c} = ?, `).join('')}updated_at = NOW(), updated_by = ? WHERE id = ?`,
    [...columns.map((c) => changes[c]), adminId, id],
  );
}

export async function replacePhones(db: Queryable, personId: number, phones: PhoneRow[]): Promise<void> {
  await db.query('DELETE FROM people_phones WHERE person_id = ?', [personId]);
  if (phones.length === 0) return;
  await db.query(
    'INSERT INTO people_phones (person_id, phone, phone_normalized, label, channel, is_primary, sort_order) VALUES ?',
    [phones.map((p) => [personId, p.phone, p.phone_normalized, p.label, p.channel, p.is_primary, p.sort_order])],
  );
}

export async function replaceAddresses(db: Queryable, personId: number, addresses: AddressValues[]): Promise<void> {
  await db.query('DELETE FROM people_addresses WHERE person_id = ?', [personId]);
  if (addresses.length === 0) return;
  await db.query('INSERT INTO people_addresses (person_id, kind, line1, line2, city, state, zip) VALUES ?', [
    addresses.map((a) => [personId, a.kind, a.line1, a.line2, a.city, a.state, a.zip]),
  ]);
}

export interface HouseholdRow {
  member_id: number;
  family_id: number;
  family_name: string;
  household_phone: string;
  relationship: string;
  is_primary: number;
}

/** The active families the person is an active member of, by family name. */
export async function householdsOf(db: Queryable, personId: number): Promise<HouseholdRow[]> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT fm.id AS member_id, f.id AS family_id, f.name AS family_name, f.household_phone, fm.relationship,
            fm.is_primary
       FROM family_members fm
       JOIN families f ON f.id = fm.family_id AND f.status = 'active'
      WHERE fm.person_id = ? AND fm.status = 'active'
      ORDER BY f.name, f.id`,
    [personId],
  );
  return rows as HouseholdRow[];
}
