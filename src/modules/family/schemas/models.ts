// Response models of the Family API. Each has a $id, is added with app.addSchema (familySchemas),
// and appears under that name in openapi/family.json, so Tendi-new's generated types get names.
// Field names are the SCHEMA.md column names; booleans are the tinyint(1) flags.

import Type from 'typebox';
import {
  AddressKind,
  DateTime,
  Id,
  NotifyMethod,
  NullableDate,
  PhoneChannel,
  PhoneLabel,
  RecordStatus,
  Relationship,
  Text,
} from './values.ts';

export const PersonPhone = Type.Object(
  {
    id: Id,
    phone: Text(255, 'As typed'),
    phone_normalized: Text(20, 'Computed by the API: digits only, last 10 ("" below 10 digits)'),
    label: PhoneLabel,
    channel: PhoneChannel,
    is_primary: Type.Boolean(),
    sort_order: Type.Integer(),
  },
  { $id: 'PersonPhone' },
);

export const PersonAddress = Type.Object(
  {
    id: Id,
    kind: AddressKind,
    line1: Text(255),
    line2: Text(255),
    city: Text(100),
    state: Text(25),
    zip: Text(15),
  },
  { $id: 'PersonAddress' },
);

export const Person = Type.Object(
  {
    id: Id,
    fname: Text(100),
    lname: Text(100),
    legacy_full_name: Text(100, 'Mirrored verbatim to children.father_name / mother_name'),
    hebrew_name: Text(255),
    email: Text(255),
    note: Type.Union([Type.String({ maxLength: 16777215 }), Type.Null()]),
    occupation: Text(150),
    employer: Text(150),
    status: RecordStatus,
    phones: Type.Array(Type.Ref('PersonPhone')),
    addresses: Type.Array(Type.Ref('PersonAddress')),
    created_at: DateTime,
    updated_at: DateTime,
  },
  { $id: 'Person' },
);

export const FamilyMember = Type.Object(
  {
    id: Id,
    family_id: Id,
    person_id: Id,
    relationship: Relationship,
    is_primary: Type.Boolean(),
    sort_order: Type.Integer(),
    status: RecordStatus,
    person: Type.Ref('Person'),
  },
  { $id: 'FamilyMember' },
);

export const ChildRight = Type.Object(
  {
    id: Id,
    member_id: Id,
    child_id: Id,
    is_primary: Type.Boolean(),
    receives_notifications: Type.Boolean(),
    notify_method: NotifyMethod,
    may_collect: Type.Boolean(),
    collect_from: NullableDate,
    collect_to: NullableDate,
    is_emergency: Type.Boolean(),
    is_payment_responsible: Type.Boolean(),
  },
  { $id: 'ChildRight' },
);

const familyChildFields = {
  id: Id,
  fname: Text(25),
  lname: Text(25),
  class_id: Type.Integer({ description: 'children.class (0 = none)' }),
  class_name: Type.Union([Type.String({ maxLength: 50 }), Type.Null()], {
    description: 'classes.name; null when children.class has no classes row',
  }),
  linked: Type.Boolean({
    description:
      'children.family_id is this family (otherwise the child only has rights rows here, as a backfill draft)',
  }),
};

export const FamilyChild = Type.Object(
  {
    ...familyChildFields,
    rights: Type.Array(Type.Ref('ChildRight'), { description: "Rights rows of this family's members for the child" }),
  },
  { $id: 'FamilyChild', description: 'A child linked to the family, or with rights rows of its members' },
);

export const Family = Type.Object(
  {
    id: Id,
    name: Text(100),
    household_phone: Text(255, 'Mirrored to children.home_phone'),
    status: RecordStatus,
    created_at: DateTime,
    updated_at: DateTime,
    members: Type.Array(Type.Ref('FamilyMember'), { description: 'Active members, by sort_order' }),
    children: Type.Array(Type.Ref('FamilyChild')),
  },
  { $id: 'Family' },
);

export const FamilySummary = Type.Object(
  {
    id: Id,
    name: Text(100),
    household_phone: Text(255),
    status: RecordStatus,
    members: Type.Array(
      Type.Object({ person_id: Id, name: Text(201), relationship: Relationship, is_primary: Type.Boolean() }),
      { description: 'Active members, by sort_order' },
    ),
    children: Type.Array(Type.Object(familyChildFields), {
      description: 'Linked children, then children with rights rows of its members (linked: false), as in Family',
    }),
    member_count: Type.Integer({ minimum: 0 }),
    child_count: Type.Integer({ minimum: 0, description: 'Children listed in children, linked or not' }),
  },
  { $id: 'FamilySummary' },
);

export const FamilySearchResult = Type.Object(
  {
    items: Type.Array(Type.Ref('FamilySummary')),
    total: Type.Integer({ minimum: 0, description: 'Matching families, all pages' }),
    page: Type.Integer({ minimum: 1 }),
    page_size: Type.Integer({ minimum: 1 }),
  },
  { $id: 'FamilySearchResult' },
);

const nullableText = (maxLength: number) => Type.Union([Type.String({ maxLength }), Type.Null()]);
const nullableBit = Type.Union([Type.Literal(0), Type.Literal(1), Type.Null()]);
const nullableNotify = Type.Union([NotifyMethod, Type.Null()]);

/**
 * The 28 legacy parent columns the mirror owns, typed like the columns (children: 10;
 * children_additional_information: 18, NULL where the child has no such row or the row holds
 * NULL). home_send_notification is not mirrored and not part of the preview.
 */
export const LegacyParentValues = Type.Object(
  {
    father_name: Text(100),
    mother_name: Text(100),
    father_phone: Text(255),
    mother_phone: Text(255),
    home_phone: Text(255),
    parent_email: Text(255),
    use_father_phone_for_notification: nullableBit,
    use_mother_phone_for_notification: nullableBit,
    notification_father_phone_method: nullableNotify,
    notification_mother_phone_method: nullableNotify,
    father_fname: nullableText(100),
    father_lname: nullableText(100),
    father_home_phone: nullableText(30),
    father_email: nullableText(150),
    father_address: nullableText(255),
    father_occupation: nullableText(150),
    father_employer: nullableText(150),
    father_work_address: nullableText(255),
    father_office_phone: nullableText(30),
    mother_fname: nullableText(100),
    mother_lname: nullableText(100),
    mother_home_phone: nullableText(30),
    mother_email: nullableText(150),
    mother_address: nullableText(255),
    mother_occupation: nullableText(150),
    mother_employer: nullableText(150),
    mother_work_address: nullableText(255),
    mother_office_phone: nullableText(30),
  },
  { $id: 'LegacyParentValues' },
);

export const LinkPreview = Type.Object(
  {
    child_id: Id,
    family_id: Id,
    current: Type.Ref('LegacyParentValues', {
      description: 'What children / children_additional_information hold now',
    }),
    after_link: Type.Ref('LegacyParentValues', { description: 'What the mirror would write when linked' }),
    changed: Type.Array(Type.String(), { description: 'Columns whose value would change' }),
  },
  { $id: 'LinkPreview' },
);

export const LinkResult = Type.Object(
  { child_id: Id, family_id: Type.Union([Id, Type.Null()]) },
  { $id: 'LinkResult', description: 'children.family_id after the change (null = unlinked)' },
);

export const StaffMember = Type.Object(
  {
    admin_id: Id,
    type: Type.String({ description: 'admin.type' }),
    name: Type.String(),
  },
  { $id: 'StaffMember' },
);

/** Every shared schema of the module, in dependency order, for app.addSchema. */
export const familySchemas = [
  PersonPhone,
  PersonAddress,
  Person,
  FamilyMember,
  ChildRight,
  FamilyChild,
  Family,
  FamilySummary,
  FamilySearchResult,
  LegacyParentValues,
  LinkPreview,
  LinkResult,
  StaffMember,
];
