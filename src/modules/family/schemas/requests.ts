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
        minLength: 1,
        maxLength: 255,
        description: 'Family name, person name, or any phone (matched on phone_normalized)',
      }),
    ),
    limit: withDefault(Type.Integer({ minimum: 1, maximum: 100 }), 25),
    offset: withDefault(Type.Integer({ minimum: 0 }), 0),
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
  legacy_full_name: Text(
    100,
    'Mirrored verbatim to the legacy father_name / mother_name. For a new person it defaults to "fname lname", which must then be at most 100 characters',
  ),
  hebrew_name: Text(255),
  email: Text(255, 'Column varchar(255); the API accepts at most 150 characters (legacy *_email is varchar(150))'),
  note: Type.Union([Type.String({ maxLength: 16777215 }), Type.Null()]),
  occupation: Text(150),
  employer: Text(150),
};

export const NewPersonInput = body({
  fname: withDefault(Text(100), ''),
  lname: withDefault(Text(100), ''),
  legacy_full_name: Type.Optional(personFields.legacy_full_name),
  hebrew_name: Type.Optional(personFields.hebrew_name),
  email: Type.Optional(personFields.email),
  note: Type.Optional(personFields.note),
  occupation: Type.Optional(personFields.occupation),
  employer: Type.Optional(personFields.employer),
});

export const UpdatePersonBody = body(
  Object.fromEntries(Object.entries(personFields).map(([k, v]) => [k, Type.Optional(v)])),
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
  { description: 'The full set for this child in this family; collect_to >= collect_from.' },
);
