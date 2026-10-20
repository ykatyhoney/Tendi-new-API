// Allowed values and field schemas of the Family API, sized exactly like the columns in SCHEMA.md
// ("Column definitions"). Every enum here is one exported constant, so the API, the OpenAPI
// document (openapi/family.json) and Tendi-new's generated types share one list.

import Type from 'typebox';

/**
 * family_members.relationship (varchar(32), no database CHECK: the API validates it).
 * Only father, mother, step_father and step_mother fill the legacy parent slots (the mirror).
 */
export const RELATIONSHIPS = [
  'father',
  'mother',
  'step_father',
  'step_mother',
  'guardian',
  'foster_parent',
  'grandfather',
  'grandmother',
  'brother',
  'sister',
  'uncle',
  'aunt',
  'cousin',
  'nanny',
  'babysitter',
  'car_service',
  'doctor',
  'family_friend',
  'other',
] as const;
export type Relationship = (typeof RELATIONSHIPS)[number];

/** Relationships that fill a legacy parent slot (father / mother columns). */
export const PARENT_SLOT_RELATIONSHIPS = ['father', 'mother', 'step_father', 'step_mother'] as const;

export const RECORD_STATUSES = ['active', 'trash'] as const; // families.status, people.status, family_members.status
export const NOTIFY_METHODS = ['sms', 'voice', 'both'] as const; // family_member_children.notify_method
export const PHONE_CHANNELS = ['none', 'sms', 'voice', 'both'] as const; // people_phones.channel
export const PHONE_LABELS = ['mobile', 'home', 'work'] as const; // people_phones.label (varchar(32))
export const ADDRESS_KINDS = ['home', 'work', 'billing'] as const; // people_addresses.kind (varchar(32))

/** What the link preview warns about (GET /families/:id/children/:childId/preview). */
export const LINK_WARNING_CODES = [
  'linked_to_other_family', // children.family_id is another family: linking moves the child (force=move)
  'no_rights', // no active member has a rights row for the child: link answers 409
  'no_father', // no active father / step_father: the father_* columns become empty
  'no_mother', // no active mother / step_mother: the mother_* columns become empty
  'no_primary_phone', // a parent slot's person has no primary phone: father_phone / mother_phone become empty
  'no_payment_responsible', // nobody is payment-responsible for the child: parent_email is the primary member's
] as const;

const stringEnum = <T extends readonly string[]>(values: T, maxLength: number, description: string) =>
  Type.Unsafe<T[number]>({ type: 'string', enum: [...values], maxLength, description });

export const Relationship = stringEnum(
  RELATIONSHIPS,
  32,
  'family_members.relationship. Only father, mother, step_father and step_mother fill the legacy parent slots.',
);
export const RecordStatus = stringEnum(RECORD_STATUSES, 5, 'active, or trash (soft-deleted)');
export const NotifyMethod = stringEnum(NOTIFY_METHODS, 5, 'family_member_children.notify_method');
export const PhoneChannel = stringEnum(PHONE_CHANNELS, 5, 'people_phones.channel');
export const PhoneLabel = stringEnum(PHONE_LABELS, 32, 'people_phones.label');
export const AddressKind = stringEnum(ADDRESS_KINDS, 32, 'people_addresses.kind');
export const LinkWarningCode = stringEnum(LINK_WARNING_CODES, 32, 'What the warning is about');

/** A row id (int(11), auto-increment). */
export const Id = Type.Integer({ minimum: 1, maximum: 2147483647 });

/** varchar(n) NOT NULL, empty allowed. */
export const Text = (maxLength: number, description?: string) =>
  Type.String({ maxLength, ...(description ? { description } : {}) });

/** An ISO date (YYYY-MM-DD) or null: family_member_children.collect_from / collect_to. */
export const NullableDate = Type.Union([Type.String({ format: 'date' }), Type.Null()]);

/** A database datetime as the API returns it ('YYYY-MM-DD HH:MM:SS', server local time). */
export const DateTime = Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}$' });
