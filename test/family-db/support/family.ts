// Builders for family fixtures and readers for the 29 legacy parent values.
// Every builder writes inside the test's transaction, so nothing outlives the test.

import type { RowDataPacket } from 'mysql2/promise';
import { normalizePhone } from '../../../scripts/family/lib/phone.ts';
import { rows, value } from './db.ts';
import type { Db } from './db.ts';

/** The 10 mirrored children columns (home_send_notification is not mirrored; it stays as stored). */
export const CHILDREN_COLUMNS = [
  'father_name', 'mother_name', 'father_phone', 'mother_phone', 'home_phone', 'parent_email',
  'use_father_phone_for_notification', 'use_mother_phone_for_notification',
  'notification_father_phone_method', 'notification_mother_phone_method',
] as const;

export const CAI_COLUMNS = ['father', 'mother'].flatMap((slot) =>
  ['fname', 'lname', 'home_phone', 'email', 'address', 'occupation', 'employer', 'work_address', 'office_phone']
    .map((field) => `${slot}_${field}`),
);

export const LEGACY_COLUMNS = [...CHILDREN_COLUMNS, ...CAI_COLUMNS];

const BIT_COLUMNS = new Set(['use_father_phone_for_notification', 'use_mother_phone_for_notification']);

export type Legacy = Record<string, string | number | null>;

/** BIT(1) columns arrive as Buffers; compare them as 0 / 1 / null. */
function normalize(row: RowDataPacket): Legacy {
  const out: Legacy = {};
  for (const column of LEGACY_COLUMNS) {
    const raw = row[column];
    out[column] = BIT_COLUMNS.has(column) && Buffer.isBuffer(raw) ? raw[0] : raw;
  }
  return out;
}

/**
 * How an empty value of each CAI column looks for this child after mirroring: NULL where the
 * stored value is NULL, '' otherwise (sp_family_mirror_values keeps the legacy representation).
 */
export async function emptyAs(db: Db, childId: number): Promise<Record<string, null | ''>> {
  const [row] = await rows(db, `SELECT ${CAI_COLUMNS.join(', ')} FROM children_additional_information WHERE child_id = ?`, [childId]);
  return Object.fromEntries(CAI_COLUMNS.map((c) => [c, row && row[c] === null ? null : '']));
}

/** The 28 mirrored values as stored (children LEFT JOIN children_additional_information). */
export async function storedLegacy(db: Db, childId: number): Promise<Legacy> {
  const [row] = await rows(db, `
    SELECT ${CHILDREN_COLUMNS.map((c) => `c.${c}`).join(', ')}, ${CAI_COLUMNS.map((c) => `cai.${c}`).join(', ')}
      FROM children c LEFT JOIN children_additional_information cai ON cai.child_id = c.id
     WHERE c.id = ?`, [childId]);
  return normalize(row);
}

/** The 28 values sp_family_preview derives, without writing anything. */
export async function preview(db: Db, childId: number, familyId: number | null = null): Promise<Legacy> {
  const [result] = await db.query<RowDataPacket[][]>('CALL sp_family_preview(?, ?)', [childId, familyId]);
  return normalize(result[0][0]);
}

/**
 * Unlinked children; `withCai` picks children that do or do not have a CAI row. Only active
 * children unless `anyStatus` (the 4 children without a CAI row in the dump are all inactive).
 */
export async function pickChildren(db: Db, count: number, { withCai = true, anyStatus = false } = {}): Promise<number[]> {
  const found = await rows<{ id: number }>(db, `
    SELECT c.id FROM children c
      LEFT JOIN children_additional_information cai ON cai.child_id = c.id
     WHERE (c.status = 'active' OR ?) AND c.family_id IS NULL AND (cai.id IS NOT NULL) = ?
     ORDER BY c.id LIMIT ?`, [anyStatus, withCai, count]);
  if (found.length < count) throw new Error(`need ${count} children (withCai=${withCai}), found ${found.length}`);
  return found.map((r) => r.id);
}

async function insert(db: Db, sql: string, params: unknown[]): Promise<number> {
  const [result] = await db.query(sql, params);
  return (result as { insertId: number }).insertId;
}

export function createFamily(db: Db, { name = 'Test family', householdPhone = '', status = 'active' } = {}) {
  return insert(db, `INSERT INTO families (name, household_phone, status, created_at, updated_at, created_by, updated_by)
                     VALUES (?, ?, ?, NOW(), NOW(), 0, 0)`, [name, householdPhone, status]);
}

export interface PersonInput {
  /** Defaults to "fname lname", as the API sets it for people it creates; pass '' for an empty legacy name. */
  legacyFullName?: string;
  fname: string; lname: string; email?: string;
  occupation?: string; employer?: string; status?: 'active' | 'trash';
}

export function createPerson(db: Db, p: PersonInput) {
  return insert(db, `INSERT INTO people (fname, lname, legacy_full_name, email, occupation, employer, status,
                                         created_at, updated_at, created_by, updated_by)
                     VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), 0, 0)`,
  [p.fname, p.lname, p.legacyFullName ?? `${p.fname} ${p.lname}`, p.email ?? '', p.occupation ?? '', p.employer ?? '', p.status ?? 'active']);
}

export function addPhone(db: Db, personId: number,
  { phone, label = 'mobile', isPrimary = false, sortOrder = 0, channel = 'sms' }:
  { phone: string; label?: string; isPrimary?: boolean; sortOrder?: number; channel?: string }) {
  const normalized = normalizePhone(phone);
  return insert(db, `INSERT INTO people_phones (person_id, phone, phone_normalized, label, channel, is_primary, sort_order)
                     VALUES (?, ?, ?, ?, ?, ?, ?)`, [personId, phone, normalized, label, channel, isPrimary, sortOrder]);
}

export function addAddress(db: Db, personId: number,
  { kind = 'home', line1, line2 = '', city = '', state = '', zip = '' }:
  { kind?: string; line1: string; line2?: string; city?: string; state?: string; zip?: string }) {
  return insert(db, `INSERT INTO people_addresses (person_id, kind, line1, line2, city, state, zip)
                     VALUES (?, ?, ?, ?, ?, ?, ?)`, [personId, kind, line1, line2, city, state, zip]);
}

export function addMember(db: Db, familyId: number, personId: number,
  { relationship, isPrimary = false, sortOrder = 0, status = 'active' }:
  { relationship: string; isPrimary?: boolean; sortOrder?: number; status?: 'active' | 'trash' }) {
  return insert(db, `INSERT INTO family_members (family_id, person_id, relationship, is_primary, sort_order, status)
                     VALUES (?, ?, ?, ?, ?, ?)`, [familyId, personId, relationship, isPrimary, sortOrder, status]);
}

export function setRights(db: Db, memberId: number, childId: number,
  { receivesNotifications = false, notifyMethod = 'sms', isPaymentResponsible = false, isPrimary = false, mayCollect = false } = {}) {
  return insert(db, `INSERT INTO family_member_children
                       (member_id, child_id, is_primary, receives_notifications, notify_method, may_collect, is_payment_responsible)
                     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  [memberId, childId, isPrimary, receivesNotifications, notifyMethod, mayCollect, isPaymentResponsible]);
}

export async function link(db: Db, childId: number, familyId: number | null): Promise<void> {
  await db.query('UPDATE children SET family_id = ? WHERE id = ?', [familyId, childId]);
}

export function lockLogCount(db: Db, childId: number) {
  return value<number>(db, 'SELECT COUNT(*) FROM family_mirror_lock_log WHERE child_id = ?', [childId]);
}

/**
 * A household with a father and a mother, each with a primary mobile, and rights rows for
 * the given children (father receives sms notifications, mother pays).
 */
export async function createParents(db: Db, childIds: number[], { householdPhone = '718-555-0100' } = {}) {
  const familyId = await createFamily(db, { name: 'Parents', householdPhone });
  const fatherId = await createPerson(db, { fname: 'Avraham', lname: 'Test', legacyFullName: 'Avi Test', email: 'avi@example.test' });
  const motherId = await createPerson(db, { fname: 'Sara', lname: 'Test', email: 'sara@example.test' });
  await addPhone(db, fatherId, { phone: '347-555-0111', isPrimary: true });
  await addPhone(db, motherId, { phone: '347-555-0121', isPrimary: true });
  const fatherMember = await addMember(db, familyId, fatherId, { relationship: 'father', isPrimary: true, sortOrder: 0 });
  const motherMember = await addMember(db, familyId, motherId, { relationship: 'mother', sortOrder: 1 });
  for (const childId of childIds) {
    await setRights(db, fatherMember, childId, { receivesNotifications: true, notifyMethod: 'sms' });
    await setRights(db, motherMember, childId, { notifyMethod: 'voice', isPaymentResponsible: true });
  }
  return { familyId, fatherId, motherId, fatherMember, motherMember };
}
