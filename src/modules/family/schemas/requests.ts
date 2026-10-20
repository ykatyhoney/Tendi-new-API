// Request schemas (params, query, bodies) of the Family API. Bodies and the search query reject
// unknown fields with 400 (additionalProperties: false, Ajv removeAdditional off in src/app.ts),
// so a misspelled field or a computed column such as phone_normalized is never silently ignored. Rules JSON Schema cannot express (one primary phone,
// collect_to >= collect_from, mirror target lengths) are checked in service/validation.ts.

import Type, { type Static, type TObjectOptions, type TProperties, type TSchema } from 'typebox';
import { AddressKind, Id, NotifyMethod, NullableDate, PhoneChannel, PhoneLabel, Relationship, Text } from './values.ts';

const body = <P extends TProperties>(properties: P, options: TObjectOptions = {}) =>
  Type.Object(properties, { additionalProperties: false, ...options });

/** An optional field the API fills with `value` when it is missing (Ajv useDefaults). */
const withDefault = <S extends TSchema>(schema: S, value: unknown) =>
  Type.Optional(Type.Unsafe<Static<S>>({ ...schema, default: value }));

// --- Path and query -----------------------------------------------------------------------------

export const FamilyParams = Type.Object({ id: Id });
export const FamilyMemberParams = Type.Object({ id: Id, memberId: Id });
export const FamilyChildParams = Type.Object({ id: Id, childId: Id });
export const PersonParams = Type.Object({ id: Id });
export const ChildParams = Type.Object({ childId: Id });

export const SearchFamiliesQuery = Type.Object(
  {
    q: Type.Optional(
      Type.String({
        minLength: 2,
        maxLength: 255,
        description:
          'At least 2 characters other than surrounding spaces. A phone with 10 digits matches people_phones.phone_normalized or families.household_phone_normalized exactly; 4-9 digits match the end of either. Anything else matches anywhere in the family name or in a member’s fname, lname or legacy_full_name, ignoring case',
      }),
    ),
    page: withDefault(Type.Integer({ minimum: 1 }), 1),
    pageSize: withDefault(Type.Integer({ minimum: 1, maximum: 100 }), 25),
  },
  { additionalProperties: false },
);

// --- Families -------------------------------------------------------------------------------------

export const CreateFamilyBody = body({
  name: Type.String({ minLength: 1, maxLength: 100 }),
  household_phone: withDefault(
    Text(
      255,
      'Column varchar(255); the API accepts at most 30 characters (mirrored as the legacy home phone fallback, varchar(30))',
    ),
    '',
  ),
});

export const UpdateFamilyBody = body(
  {
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
    household_phone: Type.Optional(
      Text(
        255,
        'Column varchar(255); the API accepts at most 30 characters (mirrored as the legacy home phone fallback, varchar(30))',
      ),
    ),
  },
  { minProperties: 1 },
);

// --- People and members ---------------------------------------------------------------------------

const personFields = {
  fname: Text(100),
  lname: Text(100),
  hebrew_name: Text(255),
  email: Text(255, 'Column varchar(255); the API accepts at most 150 characters (legacy *_email is varchar(150))'),
  note: Type.Union([Type.String({ maxLength: 16777215 }), Type.Null()]),
  occupation: Text(150),
  employer: Text(150),
};

export const NewPersonInput = body(
  {
    fname: withDefault(Text(100), ''),
    lname: withDefault(Text(100), ''),
    hebrew_name: Type.Optional(personFields.hebrew_name),
    email: Type.Optional(personFields.email),
    note: Type.Optional(personFields.note),
    occupation: Type.Optional(personFields.occupation),
    employer: Type.Optional(personFields.employer),
  },
  {
    description:
      'legacy_full_name is set to "fname lname" (mirrored to the legacy father_name / mother_name, varchar(100)), so "fname lname" may have at most 100 characters',
  },
);

export const UpdatePersonBody = body(
  {
    fname: Type.Optional(personFields.fname),
    lname: Type.Optional(personFields.lname),
    hebrew_name: Type.Optional(personFields.hebrew_name),
    email: Type.Optional(personFields.email),
    note: Type.Optional(personFields.note),
    occupation: Type.Optional(personFields.occupation),
    employer: Type.Optional(personFields.employer),
    reset_legacy_full_name: Type.Optional(
      Type.Boolean({
        description:
          'true sets legacy_full_name to "fname lname" (after this edit; at most 100 characters). legacy_full_name is mirrored verbatim to the legacy father_name / mother_name and is never set to a free value; a change of fname or lname also sets it to "fname lname"',
      }),
    ),
  },
  { minProperties: 1 },
);

export const AddMemberBody = body(
  {
    person_id: Type.Optional(Id),
    person: Type.Optional(NewPersonInput),
    relationship: Relationship,
    is_primary: withDefault(Type.Boolean(), false),
    sort_order: withDefault(Type.Integer(), 0),
  },
  { description: 'Exactly one of person_id (an existing person) or person (a new one).' },
);

export const UpdateMemberBody = body(
  {
    relationship: Type.Optional(Relationship),
    is_primary: Type.Optional(Type.Boolean()),
    sort_order: Type.Optional(Type.Integer()),
  },
  { minProperties: 1 },
);

// --- Phones and addresses -------------------------------------------------------------------------

export const PhoneInput = body({
  phone: Type.String({
    minLength: 1,
    maxLength: 255,
    description:
      'As typed; phone_normalized is computed. A home or work phone may have at most 30 characters (legacy varchar(30))',
  }),
  label: PhoneLabel,
  channel: withDefault(PhoneChannel, 'sms'),
  is_primary: withDefault(Type.Boolean(), false),
  sort_order: Type.Optional(Type.Integer({ description: 'Defaults to the position in the list' })),
});

export const ReplacePhonesBody = body(
  { phones: Type.Array(PhoneInput, { maxItems: 20 }) },
  { description: 'The full list; exactly one is_primary when the list is not empty.' },
);

export const AddressInput = body(
  {
    kind: AddressKind,
    line1: withDefault(Text(255), ''),
    line2: withDefault(Text(255), ''),
    city: withDefault(Text(100), ''),
    state: withDefault(Text(25), ''),
    zip: withDefault(Text(15), ''),
  },
  {
    description:
      'A home or work address is mirrored as "line1, line2, city, state zip"; that text may have at most 255 characters',
  },
);

export const ReplaceAddressesBody = body({ addresses: Type.Array(AddressInput, { maxItems: 10 }) });

// --- Rights per child -----------------------------------------------------------------------------

export const ChildRightInput = body({
  member_id: Id,
  is_primary: withDefault(Type.Boolean(), false),
  receives_notifications: withDefault(Type.Boolean(), false),
  notify_method: withDefault(NotifyMethod, 'sms'),
  may_collect: withDefault(Type.Boolean(), false),
  collect_from: withDefault(NullableDate, null),
  collect_to: withDefault(NullableDate, null),
  is_emergency: withDefault(Type.Boolean(), false),
  is_payment_responsible: withDefault(Type.Boolean(), false),
});

export const SetChildRightsBody = body(
  { rights: Type.Array(ChildRightInput, { maxItems: 50 }) },
  {
    description:
      "The full set for this child in this family: each member_id an active member of the family, at most once; collect_to >= collect_from. Rows of active members not in the list are deleted (a removed member's rows are kept).",
  },
);

// --- Link -----------------------------------------------------------------------------------------

export const LinkChildQuery = Type.Object(
  {
    force: Type.Optional(
      Type.Literal('move', {
        description: 'Required to move a child that is linked to another family to this one',
      }),
    ),
  },
  { additionalProperties: false },
);
