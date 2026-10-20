// Request rules that JSON Schema cannot express. Each route runs its check in a route preHandler
// (after the staff auth hook and schema validation), so a violation answers 400 in the usual
// { statusCode, error, message } format before any handler or transaction starts.
//
// Mirror limits. The mirror (sp_family_mirror_values, migrations 010/011 as changed by 022) writes
// 28 legacy columns from the family tables; it refuses a value longer than its target column,
// which would fail the whole write. Audit of all 28 (legacy max vs longest value the API inputs
// can produce):
//
//   children.father_name / mother_name   100  <- people.legacy_full_name verbatim, which the API
//        only ever sets to "fname lname" (up to 201) -> limited to 100 (checkAddMember; the
//        reset_legacy_full_name check in service/people.ts)
//   children.father_phone / mother_phone 255  <- primary phone                          255  ok
//   children.home_phone                  255  <- families.household_phone               255  ok
//   children.parent_email                255  <- people.email                           255  ok
//   children.use_*_phone_for_notification bit <- boolean                                     ok
//   children.notification_*_phone_method enum <- enum                                        ok
//   cai.*_fname / *_lname                100  <- people.fname / lname                   100  ok
//   cai.*_home_phone                      30  <- home-labelled phone                    255  -> 30 (checkPhones)
//                                             <- else families.household_phone          255  -> 30 (checkHouseholdPhone)
//   cai.*_office_phone                    30  <- work-labelled phone                    255  -> 30 (checkPhones)
//   cai.*_email                          150  <- people.email                           255  -> 150 (checkEmail)
//   cai.*_address / *_work_address       255  <- formatted home / work address         ~655  -> 255 (checkAddresses)
//   cai.*_occupation / *_employer        150  <- people.occupation / employer           150  ok
//
// Lengths are counted in characters (code points), as MariaDB varchar and Ajv maxLength do.

import { HttpError } from '../../../errors.ts';

export const MIRROR_NAME_MAX = 100;
export const MIRROR_EMAIL_MAX = 150;
export const MIRROR_PHONE_MAX = 30;
export const MIRROR_ADDRESS_MAX = 255;

/** Length in characters (code points), like MariaDB varchar(n). */
export const charLength = (value: string) => [...value].length;

const fail = (message: string): never => {
  throw new HttpError(400, message);
};

interface PhoneLike {
  phone: string;
  label: string;
  is_primary?: boolean;
}

/** Exactly one primary phone when there are any; home / work phones fit the legacy columns. */
export function checkPhones(phones: PhoneLike[]): void {
  const primaries = phones.filter((p) => p.is_primary).length;
  if (phones.length > 0 && primaries !== 1) {
    fail(`phones: exactly one phone must have is_primary = true (found ${primaries})`);
  }
  phones.forEach((p, i) => {
    if ((p.label === 'home' || p.label === 'work') && charLength(p.phone) > MIRROR_PHONE_MAX) {
      fail(
        `phones/${i}/phone: a ${p.label} phone is mirrored to a varchar(${MIRROR_PHONE_MAX}) legacy column; at most ${MIRROR_PHONE_MAX} characters`,
      );
    }
  });
}

/**
 * families.household_phone is mirrored to children.home_phone (255) and is the fallback for
 * children_additional_information.*_home_phone (30) of any parent without a home-labelled phone.
 */
export function checkHouseholdPhone(householdPhone: string | undefined): void {
  if (householdPhone !== undefined && charLength(householdPhone) > MIRROR_PHONE_MAX) {
    fail(
      `household_phone: used for the varchar(${MIRROR_PHONE_MAX}) legacy home phone of parents without a home phone; at most ${MIRROR_PHONE_MAX} characters`,
    );
  }
}

interface AddressLike {
  kind: string;
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  zip?: string;
}

/** The address as the mirror formats it: "line1, line2, city, state zip", empty parts skipped. */
export function formatAddress(a: AddressLike): string {
  const part = (v: string | undefined) => (v ?? '').trim();
  const stateZip = [part(a.state), part(a.zip)].filter(Boolean).join(' ');
  return [part(a.line1), part(a.line2), part(a.city), stateZip].filter(Boolean).join(', ');
}

export function checkAddresses(addresses: AddressLike[]): void {
  addresses.forEach((a, i) => {
    if ((a.kind === 'home' || a.kind === 'work') && charLength(formatAddress(a)) > MIRROR_ADDRESS_MAX) {
      fail(
        `addresses/${i}: a ${a.kind} address is mirrored as one varchar(${MIRROR_ADDRESS_MAX}) value; the formatted address is too long`,
      );
    }
  });
}

export function checkEmail(email: string | undefined): void {
  if (email !== undefined && charLength(email) > MIRROR_EMAIL_MAX) {
    fail(`email: mirrored to a varchar(${MIRROR_EMAIL_MAX}) legacy column; at most ${MIRROR_EMAIL_MAX} characters`);
  }
}

interface NewPersonLike {
  fname?: string;
  lname?: string;
  email?: string;
}

/** The legacy name the API sets: "fname lname" (people.legacy_full_name). */
export function defaultLegacyName(person: NewPersonLike): string {
  return [person.fname ?? '', person.lname ?? '']
    .map((s) => s.trim())
    .filter(Boolean)
    .join(' ');
}

/** POST /families/:id/members: exactly one of person_id (existing) or person (new). */
export function checkAddMember(body: { person_id?: number; person?: NewPersonLike }): void {
  if ((body.person_id === undefined) === (body.person === undefined)) {
    fail('exactly one of person_id (an existing person) or person (a new person) is required');
  }
  const person = body.person;
  if (!person) return;
  checkEmail(person.email);
  if (charLength(defaultLegacyName(person)) > MIRROR_NAME_MAX) {
    fail(
      `person: legacy_full_name is set to "fname lname", which is mirrored to a varchar(${MIRROR_NAME_MAX}) legacy name; "fname lname" may have at most ${MIRROR_NAME_MAX} characters`,
    );
  }
}

interface RightLike {
  member_id: number;
  collect_from?: string | null;
  collect_to?: string | null;
}

/** Each member at most once; collect_to on or after collect_from when both are set. */
export function checkRights(rights: RightLike[]): void {
  const seen = new Set<number>();
  rights.forEach((r, i) => {
    if (seen.has(r.member_id)) fail(`rights/${i}/member_id: member ${r.member_id} appears more than once`);
    seen.add(r.member_id);
    if (r.collect_from && r.collect_to && r.collect_to < r.collect_from) {
      fail(`rights/${i}/collect_to: must be on or after collect_from (${r.collect_from})`);
    }
  });
}
