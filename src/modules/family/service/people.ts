// People: edit a person, replace their phones or addresses. Writes run in familyDb.transaction with
// @audit_user = the staff member, lock the person row, set updated_by / updated_at, add audit_logs
// rows, and return a warning when the mirror changed linked children's legacy values
// (service/mirror-watch.ts).

import { HttpError } from '../../../errors.ts';
import type { FamilyDb, Queryable } from '../db.ts';
import { addressesOf, type AddressRowDb, type MemberRow, type PhoneRowDb, phonesOf } from '../repository/families.ts';
import { linkedChildIdsOfPerson } from '../repository/legacy.ts';
import {
  type AddressValues,
  findPerson,
  householdsOf,
  type PersonRow,
  type PersonValues,
  replaceAddresses as replaceAddressRows,
  replacePhones as replacePhoneRows,
  updatePerson as updatePersonRow,
} from '../repository/people.ts';
import { type AuditTarget, columnChanges, writeAudit } from './audit.ts';
import type { Staff } from './auth.ts';
import { watchLegacy, withMirrorWarning } from './mirror-watch.ts';
import { preparePhones } from './phones.ts';
import { charLength, defaultLegacyName, MIRROR_NAME_MAX } from './validation.ts';

const bool = (v: number) => v === 1;

export const personName = (p: { fname: string; lname: string; legacy_full_name: string }) =>
  `${p.fname} ${p.lname}`.trim() || p.legacy_full_name;

const phoneView = (p: PhoneRowDb) => ({
  id: p.id,
  phone: p.phone,
  phone_normalized: p.phone_normalized,
  label: p.label,
  channel: p.channel,
  is_primary: bool(p.is_primary),
  sort_order: p.sort_order,
});

const addressView = (a: AddressRowDb) => ({
  id: a.id,
  kind: a.kind,
  line1: a.line1,
  line2: a.line2,
  city: a.city,
  state: a.state,
  zip: a.zip,
});

/** The Person model: the person with their phones and addresses (any person ids mixed in). */
export function personView(p: PersonRow, phones: PhoneRowDb[], addresses: AddressRowDb[]) {
  return {
    id: p.id,
    fname: p.fname,
    lname: p.lname,
    legacy_full_name: p.legacy_full_name,
    hebrew_name: p.hebrew_name,
    email: p.email,
    note: p.note,
    occupation: p.occupation,
    employer: p.employer,
    status: p.status,
    created_at: p.created_at,
    updated_at: p.updated_at,
    phones: phones.filter((x) => x.person_id === p.id).map(phoneView),
    addresses: addresses.filter((x) => x.person_id === p.id).map(addressView),
  };
}

/** The FamilyMember model from a member row joined to its person. */
export function memberView(m: MemberRow, phones: PhoneRowDb[], addresses: AddressRowDb[]) {
  const person: PersonRow = {
    id: m.person_id,
    fname: m.fname,
    lname: m.lname,
    legacy_full_name: m.legacy_full_name,
    hebrew_name: m.hebrew_name,
    email: m.email,
    note: m.note,
    occupation: m.occupation,
    employer: m.employer,
    status: m.person_status,
    created_at: m.person_created_at,
    updated_at: m.person_updated_at,
  };
  return {
    id: m.id,
    family_id: m.family_id,
    person_id: m.person_id,
    relationship: m.relationship,
    is_primary: bool(m.is_primary),
    sort_order: m.sort_order,
    status: m.status,
    person: personView(person, phones, addresses),
  };
}

/** An active person, or 404 (unknown and trashed people are both "not found"). */
export async function activePerson(db: Queryable, id: number, forUpdate = false): Promise<PersonRow> {
  const person = await findPerson(db, id, forUpdate);
  if (!person || person.status !== 'active') throw new HttpError(404, `Person ${id} not found`);
  return person;
}

async function loadPerson(db: Queryable, id: number) {
  const [person, phones, addresses] = await Promise.all([
    activePerson(db, id),
    phonesOf(db, [id]),
    addressesOf(db, [id]),
  ]);
  return personView(person, phones, addresses);
}

/** GET /people/:id: the person with phones, addresses and the households they belong to. */
export async function getPerson(db: FamilyDb, id: number) {
  const [person, households] = await Promise.all([loadPerson(db.pool, id), householdsOf(db.pool, id)]);
  return { ...person, households: households.map((h) => ({ ...h, is_primary: bool(h.is_primary) })) };
}

/** The audit target of a people row. */
export const personTarget = (person: { id: number; fname: string; lname: string; legacy_full_name: string }) =>
  ({ table: 'people', tableId: person.id, entityName: `Person ${personName(person)}` }) satisfies AuditTarget;

/** The columns PATCH /people/:id may set directly. legacy_full_name is not one of them (below). */
const EDITABLE = ['fname', 'lname', 'hebrew_name', 'email', 'note', 'occupation', 'employer'] as const;

export interface PersonEdit {
  fname?: string;
  lname?: string;
  hebrew_name?: string;
  email?: string;
  note?: string | null;
  occupation?: string;
  employer?: string;
  reset_legacy_full_name?: boolean;
}

export async function updatePerson(db: FamilyDb, staff: Staff, id: number, edit: PersonEdit) {
  const { body, affected } = await db.transaction(
    async (conn) => {
      const before = await activePerson(conn, id, true);
      const watch = await watchLegacy(conn, await linkedChildIdsOfPerson(conn, id));

      const changes: Partial<PersonValues> = {};
      for (const column of EDITABLE) {
        const value = edit[column];
        if (value !== undefined && value !== before[column]) Object.assign(changes, { [column]: value });
      }
      // legacy_full_name is mirrored verbatim to children.father_name / mother_name, the name the
      // PHP screens, reports and messages show, with no fallback to fname / lname (migration
      // family_022). The backfill copied it exactly from those columns, and the API never accepts a
      // free value for it: a typo would rewrite the name on every linked child at once. It becomes
      // "fname lname" (parts trimmed, one space, no stray space when one is empty) when fname or
      // lname actually changes, so the legacy app shows the edited name, or on an explicit
      // reset_legacy_full_name. Otherwise the backfilled value stays exactly as it was.
      const renamed = changes.fname !== undefined || changes.lname !== undefined;
      if (renamed || edit.reset_legacy_full_name) {
        const legacy = defaultLegacyName({
          fname: changes.fname ?? before.fname,
          lname: changes.lname ?? before.lname,
        });
        if (charLength(legacy) > MIRROR_NAME_MAX) {
          throw new HttpError(
            400,
            `${renamed ? 'fname / lname' : 'reset_legacy_full_name'}: legacy_full_name becomes "fname lname", which is mirrored to a varchar(${MIRROR_NAME_MAX}) legacy name; at most ${MIRROR_NAME_MAX} characters`,
          );
        }
        if (legacy !== before.legacy_full_name) changes.legacy_full_name = legacy;
      }

      const columns = Object.keys(changes) as (keyof PersonValues)[];
      if (columns.length > 0) {
        await updatePersonRow(conn, id, changes, staff.adminId);
        await writeAudit(conn, staff, columnChanges(personTarget(before), 'update', before, changes));
      }
      return { body: await loadPerson(conn, id), affected: await watch.changed() };
    },
    { auditUser: staff.adminId },
  );
  return withMirrorWarning(body, affected);
}

/** As the request sends them; the schema defaults (channel sms, is_primary false, '') apply here too. */
export interface PhoneInput {
  phone: string;
  label: string;
  channel?: string;
  is_primary?: boolean;
  sort_order?: number;
}

export type AddressInput = Partial<AddressValues> & { kind: string };

/** A phone list as compared and audited: the stored columns, by sort_order (ties by value). */
const phoneList = (
  phones: { phone: string; label: string; channel: string; is_primary: boolean | number; sort_order: number }[],
) =>
  JSON.stringify(
    phones
      .map((p) => ({
        phone: p.phone,
        label: p.label,
        channel: p.channel,
        is_primary: Boolean(p.is_primary),
        sort_order: p.sort_order,
      }))
      .sort((a, b) => a.sort_order - b.sort_order || JSON.stringify(a).localeCompare(JSON.stringify(b))),
  );

/** A list replacement is one audit row on the person, the whole list as JSON (docs/CONTEXT.md). */
const listChange = (person: PersonRow, column: 'phones' | 'addresses', oldList: string, newList: string) =>
  columnChanges(personTarget(person), 'update', { [column]: oldList }, { [column]: newList });

/** An address list as compared and audited, in stored order (by id = the order sent). */
const addressList = (addresses: AddressValues[]) =>
  JSON.stringify(
    addresses.map((a) => ({ kind: a.kind, line1: a.line1, line2: a.line2, city: a.city, state: a.state, zip: a.zip })),
  );

/** PUT /people/:id/phones: the full list (exactly one primary, checked in checkPhones). */
export async function replacePhones(db: FamilyDb, staff: Staff, id: number, input: PhoneInput[]) {
  const rows = preparePhones(
    input.map((p) => ({ ...p, channel: p.channel ?? 'sms', is_primary: p.is_primary ?? false })),
  );
  const { phones, affected } = await db.transaction(
    async (conn) => {
      const person = await activePerson(conn, id, true);
      const watch = await watchLegacy(conn, await linkedChildIdsOfPerson(conn, id));
      const current = await phonesOf(conn, [id]);
      const [oldList, newList] = [phoneList(current), phoneList(rows)];
      if (oldList !== newList) {
        await replacePhoneRows(conn, id, rows);
        await updatePersonRow(conn, id, {}, staff.adminId);
        await writeAudit(conn, staff, listChange(person, 'phones', oldList, newList));
      }
      return { phones: (await phonesOf(conn, [id])).map(phoneView), affected: await watch.changed() };
    },
    { auditUser: staff.adminId },
  );
  return withMirrorWarning({ phones }, affected);
}

/** PUT /people/:id/addresses: the full list. */
export async function replaceAddresses(db: FamilyDb, staff: Staff, id: number, sent: AddressInput[]) {
  const input: AddressValues[] = sent.map((a) => ({
    kind: a.kind,
    line1: a.line1 ?? '',
    line2: a.line2 ?? '',
    city: a.city ?? '',
    state: a.state ?? '',
    zip: a.zip ?? '',
  }));
  const { addresses, affected } = await db.transaction(
    async (conn) => {
      const person = await activePerson(conn, id, true);
      const watch = await watchLegacy(conn, await linkedChildIdsOfPerson(conn, id));
      const [oldList, newList] = [addressList(await addressesOf(conn, [id])), addressList(input)];
      if (oldList !== newList) {
        await replaceAddressRows(conn, id, input);
        await updatePersonRow(conn, id, {}, staff.adminId);
        await writeAudit(conn, staff, listChange(person, 'addresses', oldList, newList));
      }
      return { addresses: (await addressesOf(conn, [id])).map(addressView), affected: await watch.changed() };
    },
    { auditUser: staff.adminId },
  );
  return withMirrorWarning({ addresses }, affected);
}
