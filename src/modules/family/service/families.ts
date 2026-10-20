// Families: search, detail, create, edit. Writes run in familyDb.transaction with @audit_user =
// the staff member, set created_by / updated_by and the timestamps, and add audit_logs rows. A
// change to household_phone fires trg_families_au, which re-mirrors the linked children inside the
// same transaction.

import { HttpError } from '../../../errors.ts';
import { normalizePhone, phoneDigits } from '../../../lib/phone.ts';
import type { FamilyDb, Queryable } from '../db.ts';
import {
  addressesOf,
  childrenOfFamilies,
  type FamilyChildRow,
  type FamilyRow,
  type FamilySearch,
  findFamily,
  insertFamily,
  membersOf,
  phonesOf,
  type RightRowDb,
  rightsOfFamily,
  searchFamilies as searchFamilyRows,
  updateFamily as updateFamilyRow,
} from '../repository/families.ts';
import { type AuditTarget, columnChanges, writeAudit } from './audit.ts';
import type { Staff } from './auth.ts';
import { memberView, personName } from './people.ts';

/** The audit target of a families row. */
export const familyTarget = (id: number, name: string): AuditTarget => ({
  table: 'families',
  tableId: id,
  entityName: `Family ${name}`,
});

const bool = (v: number) => v === 1;

const childFields = (c: FamilyChildRow) => ({
  id: c.id,
  fname: c.fname,
  lname: c.lname,
  class_id: c.class_id,
  class_name: c.class_name,
  linked: bool(c.linked),
});

/** Shortest `q` (after trimming). */
export const MIN_SEARCH_LENGTH = 2;
const PHONE_CHARACTERS = /^[\d\s+().\-#extEXT]+$/;

/**
 * What `q` searches for: made of phone characters with 10 or more digits (after dropping an
 * extension), an exact normalized phone; with 4-9 digits, the end of a phone; otherwise (also with
 * fewer than 4 digits) a name.
 */
export function familySearch(q: string): FamilySearch {
  if (q.length < MIN_SEARCH_LENGTH) {
    throw new HttpError(400, `querystring/q must have at least ${MIN_SEARCH_LENGTH} characters other than spaces`);
  }
  if (PHONE_CHARACTERS.test(q)) {
    const phone = normalizePhone(q);
    if (phone !== '') return { phone };
    const digits = phoneDigits(q);
    if (digits.length >= 4) return { phoneSuffix: digits };
  }
  return { name: q };
}

export async function searchFamilies(db: FamilyDb, query: { q?: string; page?: number; pageSize?: number }) {
  const page = query.page ?? 1;
  const pageSize = query.pageSize ?? 25;
  const search = query.q === undefined ? null : familySearch(query.q.trim());
  const { rows, total } = await searchFamilyRows(db.pool, search, pageSize, (page - 1) * pageSize);

  const ids = rows.map((r) => r.id);
  const [members, children] = await Promise.all([membersOf(db.pool, ids), childrenOfFamilies(db.pool, ids)]);
  const items = rows.map((f) => {
    const familyMembers = members.filter((m) => m.family_id === f.id && m.person_status === 'active');
    const familyChildren = children.filter((c) => c.family_id === f.id);
    return {
      id: f.id,
      name: f.name,
      household_phone: f.household_phone,
      status: f.status,
      members: familyMembers.map((m) => ({
        person_id: m.person_id,
        name: personName(m),
        relationship: m.relationship,
        is_primary: bool(m.is_primary),
      })),
      children: familyChildren.map(childFields),
      member_count: familyMembers.length,
      child_count: familyChildren.length,
    };
  });
  return { items, total, page, page_size: pageSize };
}

/** The household as GET /families/:id returns it, read on `db` (pool or a write's connection). */
export async function familyDetail(db: Queryable, family: FamilyRow) {
  const members = await membersOf(db, [family.id]);
  const personIds = [...new Set(members.map((m) => m.person_id))];
  const [phones, addresses, children, rights] = await Promise.all([
    phonesOf(db, personIds),
    addressesOf(db, personIds),
    childrenOfFamilies(db, [family.id]),
    rightsOfFamily(db, family.id),
  ]);

  return {
    id: family.id,
    name: family.name,
    household_phone: family.household_phone,
    status: family.status,
    created_at: family.created_at,
    updated_at: family.updated_at,
    members: members.map((m) => memberView(m, phones, addresses)),
    children: children.map((c) => ({
      ...childFields(c),
      rights: rights.filter((r) => r.child_id === c.id).map(rightView),
    })),
  };
}

/** A family_member_children row as the API returns it (ChildRight). */
export const rightView = (r: RightRowDb) => ({
  id: r.id,
  member_id: r.member_id,
  child_id: r.child_id,
  is_primary: bool(r.is_primary),
  receives_notifications: bool(r.receives_notifications),
  notify_method: r.notify_method,
  may_collect: bool(r.may_collect),
  collect_from: r.collect_from,
  collect_to: r.collect_to,
  is_emergency: bool(r.is_emergency),
  is_payment_responsible: bool(r.is_payment_responsible),
});

const notFound = (id: number) => new HttpError(404, `Family ${id} not found`);

/** An active family, or 404 (unknown and trashed families are both "not found"). */
export async function activeFamily(db: Queryable, id: number, forUpdate = false): Promise<FamilyRow> {
  const family = await findFamily(db, id, forUpdate);
  if (!family || family.status !== 'active') throw notFound(id);
  return family;
}

export async function getFamily(db: FamilyDb, id: number) {
  return familyDetail(db.pool, await activeFamily(db.pool, id));
}

export async function createFamily(db: FamilyDb, staff: Staff, input: { name: string; household_phone?: string }) {
  const values = { name: input.name, household_phone: input.household_phone ?? '' };
  return db.transaction(
    async (conn) => {
      const id = await insertFamily(conn, values, staff.adminId);
      await writeAudit(conn, staff, columnChanges(familyTarget(id, values.name), 'insert', null, values));
      return familyDetail(conn, await activeFamily(conn, id));
    },
    { auditUser: staff.adminId },
  );
}

export async function updateFamily(
  db: FamilyDb,
  staff: Staff,
  id: number,
  input: { name?: string; household_phone?: string },
) {
  return db.transaction(
    async (conn) => {
      const before = await activeFamily(conn, id, true);
      const changed = (['name', 'household_phone'] as const).filter(
        (column) => input[column] !== undefined && input[column] !== before[column],
      );
      if (changed.length > 0) {
        const after = Object.fromEntries(changed.map((c) => [c, input[c]]));
        await updateFamilyRow(conn, id, after, staff.adminId);
        await writeAudit(
          conn,
          staff,
          columnChanges(familyTarget(id, input.name ?? before.name), 'update', before, after),
        );
      }
      return familyDetail(conn, await activeFamily(conn, id));
    },
    { auditUser: staff.adminId },
  );
}
