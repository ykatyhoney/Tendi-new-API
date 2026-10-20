// Response models of the Family API. Each has a $id, is added with app.addSchema (familySchemas),
// and appears under that name in openapi/family.json, so Tendi-new's generated types get names.
// Field names are the SCHEMA.md column names; booleans are the tinyint(1) flags.

import Type from 'typebox';
import {
  AddressKind,
  DateTime,
  Id,
  LinkWarningCode,
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
    legacy_full_name: Text(
      100,
      'Mirrored verbatim to children.father_name / mother_name. Read-only: set to "fname lname" for a new person, when PATCH /people/:id changes fname or lname, or with reset_legacy_full_name',
    ),
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

export const PersonHousehold = Type.Object(
  {
    member_id: Id,
    family_id: Id,
    family_name: Text(100),
    household_phone: Text(255),
    relationship: Relationship,
    is_primary: Type.Boolean({ description: "The household's primary member" }),
  },
  { $id: 'PersonHousehold', description: 'An active family the person is an active member of' },
);

export const PersonDetail = Type.Object(
  {
    ...Person.properties,
    households: Type.Array(Type.Ref('PersonHousehold'), {
      description:
        'Every active family the person is an active member of (a person can be in several), by family name. Removed memberships and trashed families are left out',
    }),
  },
  { $id: 'PersonDetail' },
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

export const MirrorWarning = Type.Object(
  {
    message: Type.String(),
    affected_child_ids: Type.Array(Id, {
      minItems: 1,
      description: 'Linked children whose mirrored legacy parent values (the 28 columns) this write changed',
    }),
  },
  {
    $id: 'MirrorWarning',
    description:
      'Not an error: the write succeeded and the mirror rewrote what the legacy app shows for these children. Absent when no linked child changed.',
  },
);

const warning = { warning: Type.Optional(Type.Ref('MirrorWarning')) };

export const PersonResult = Type.Object({ ...Person.properties, ...warning }, { $id: 'PersonResult' });

export const FamilyMemberResult = Type.Object(
  { ...FamilyMember.properties, ...warning },
  { $id: 'FamilyMemberResult' },
);

export const PhonesResult = Type.Object(
  { phones: Type.Array(Type.Ref('PersonPhone')), ...warning },
  { $id: 'PhonesResult' },
);

export const AddressesResult = Type.Object(
  { addresses: Type.Array(Type.Ref('PersonAddress')), ...warning },
  { $id: 'AddressesResult' },
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

export const ChildRightsResult = Type.Object(
  {
    rights: Type.Array(Type.Ref('ChildRight'), {
      description: "Rights rows of the family's active members for the child, by member sort_order",
    }),
    ...warning,
  },
  { $id: 'ChildRightsResult' },
);

/** A legacy column value: text, a bit as 0 / 1, an enum, or NULL. */
const legacyValue = (description: string) =>
  Type.Union([Type.String({ maxLength: 255 }), Type.Integer(), Type.Null()], { description });

export const LegacyColumnPreview = Type.Object(
  {
    column: Type.String({ description: 'The legacy column name' }),
    table: Type.Union([Type.Literal('children'), Type.Literal('children_additional_information')]),
    mirrored: Type.Boolean({
      description:
        'false for home_send_notification only: it is not mirrored and keeps its value when linked (form-owned)',
    }),
    current: legacyValue(
      'What the column holds now; null where it holds NULL or the child has no children_additional_information row',
    ),
    after_link: legacyValue(
      'What it holds once the child is linked to this family (the mirror creates a missing children_additional_information row)',
    ),
    changed: Type.Boolean({ description: 'after_link differs from current' }),
  },
  { $id: 'LegacyColumnPreview' },
);

export const LinkWarning = Type.Object(
  { code: LinkWarningCode, message: Type.String() },
  { $id: 'LinkWarning', description: 'Something staff should check before linking; never blocks the preview' },
);

export const LinkPreview = Type.Object(
  {
    child_id: Id,
    family_id: Id,
    linked_family_id: Type.Union([Id, Type.Null()], {
      description: 'children.family_id now (null = unlinked; this family = already linked)',
    }),
    columns: Type.Array(Type.Ref('LegacyColumnPreview'), {
      minItems: 29,
      maxItems: 29,
      description:
        'The 29 legacy parent columns: 11 on children, then 18 on children_additional_information. 28 are mirrored; home_send_notification is not',
    }),
    warnings: Type.Array(Type.Ref('LinkWarning')),
  },
  { $id: 'LinkPreview' },
);

export const ChildSummary = Type.Object(
  {
    id: Id,
    fname: Text(25),
    lname: Text(25),
    status: Type.Union([Type.Literal('active'), Type.Literal('inactive')], { description: 'children.status' }),
    class_id: Type.Integer({ description: 'children.class (0 = none)' }),
    class_name: Type.Union([Type.String({ maxLength: 50 }), Type.Null()], {
      description: 'classes.name; null when children.class has no classes row',
    }),
    family_id: Type.Union([Id, Type.Null()], {
      description: 'children.family_id: the family it is linked to, or null',
    }),
    family_name: Type.Union([Text(100), Type.Null()], { description: 'That family’s name; null when not linked' }),
  },
  { $id: 'ChildSummary' },
);

export const ChildSearchResult = Type.Object(
  {
    items: Type.Array(Type.Ref('ChildSummary')),
    total: Type.Integer({ minimum: 0, description: 'Matching children, all pages' }),
    page: Type.Integer({ minimum: 1 }),
    page_size: Type.Integer({ minimum: 1 }),
  },
  { $id: 'ChildSearchResult' },
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
  PersonHousehold,
  PersonDetail,
  FamilyMember,
  MirrorWarning,
  PersonResult,
  FamilyMemberResult,
  PhonesResult,
  AddressesResult,
  ChildRight,
  ChildRightsResult,
  FamilyChild,
  Family,
  FamilySummary,
  FamilySearchResult,
  LegacyColumnPreview,
  LinkWarning,
  LinkPreview,
  ChildSummary,
  ChildSearchResult,
  LinkResult,
  StaffMember,
];
