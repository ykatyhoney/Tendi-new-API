import { Type } from '@fastify/type-provider-typebox'
import {
  address,
  addressType,
  email,
  emailType,
  phone,
  phoneChannel,
  phoneType,
  recordStatus,
  searchQuery,
  sortOrder,
} from './common.js'
import { OLD_COLUMN_LIMITS } from './limits.js'

const contactPhone = Type.Object(
  {
    phone: Type.String(),
    type: phoneType,
    isPrimary: Type.Boolean(),
  },
  { additionalProperties: false },
)

const household = Type.Object(
  {
    familyId: Type.Integer(),
    familyName: Type.String(),
    familyStatus: recordStatus,
    memberId: Type.Integer(),
    relationship: Type.String(),
    relationshipLabel: Type.String(),
    isPrimary: Type.Boolean(),
    sortOrder: Type.Integer(),
  },
  { additionalProperties: false },
)

const contactSummary = Type.Object(
  {
    id: Type.Integer(),
    fname: Type.String(),
    lname: Type.String(),
    legacyFullName: Type.String(),
    phones: Type.Array(contactPhone),
    households: Type.Array(
      Type.Object(
        { familyId: Type.Integer(), familyName: Type.String() },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
)

export const contactSearchQuery = searchQuery

export const contactPage = Type.Object(
  {
    items: Type.Array(contactSummary),
    page: Type.Integer(),
    pageSize: Type.Integer(),
    total: Type.Integer(),
  },
  { additionalProperties: false },
)

export const contactDetail = Type.Object(
  {
    id: Type.Integer(),
    fname: Type.String(),
    lname: Type.String(),
    legacyFullName: Type.String(),
    hebrewName: Type.String(),
    occupation: Type.String(),
    employer: Type.String(),
    note: Type.Union([Type.String(), Type.Null()]),
    phones: Type.Array(phone),
    emails: Type.Array(email),
    addresses: Type.Array(address),
    households: Type.Array(household),
  },
  { additionalProperties: false },
)

export const contactParams = Type.Object({
  id: Type.Integer({ minimum: 1 }),
})

export const patchContactBody = Type.Object(
  {
    fname: Type.Optional(Type.String({ maxLength: OLD_COLUMN_LIMITS.name })),
    lname: Type.Optional(Type.String({ maxLength: OLD_COLUMN_LIMITS.name })),
    hebrewName: Type.Optional(Type.String({ maxLength: 255 })),
    occupation: Type.Optional(Type.String({ maxLength: OLD_COLUMN_LIMITS.occupation })),
    employer: Type.Optional(Type.String({ maxLength: OLD_COLUMN_LIMITS.employer })),
    note: Type.Optional(Type.Union([Type.String({ maxLength: 20000 }), Type.Null()])),
  },
  { additionalProperties: false },
)

const phoneInput = Type.Object(
  {
    /** An existing row of this contact to keep and update. Without it, an identical row is kept, else a new one is added. */
    id: Type.Optional(Type.Integer({ minimum: 1 })),
    phone: Type.String({ minLength: 1, maxLength: OLD_COLUMN_LIMITS.phone }),
    type: Type.Optional(phoneType),
    typeLabel: Type.Optional(Type.Union([Type.String({ maxLength: 50 }), Type.Null()])),
    channel: Type.Optional(phoneChannel),
    isPrimary: Type.Optional(Type.Boolean()),
    sortOrder: Type.Optional(sortOrder),
  },
  { additionalProperties: false },
)

const emailInput = Type.Object(
  {
    /** An existing row of this contact to keep and update. Without it, an identical row is kept, else a new one is added. */
    id: Type.Optional(Type.Integer({ minimum: 1 })),
    email: Type.String({ minLength: 1, maxLength: OLD_COLUMN_LIMITS.email }),
    type: Type.Optional(emailType),
    typeLabel: Type.Optional(Type.Union([Type.String({ maxLength: 50 }), Type.Null()])),
    isPrimary: Type.Optional(Type.Boolean()),
    sortOrder: Type.Optional(sortOrder),
  },
  { additionalProperties: false },
)

const addressInput = Type.Object(
  {
    /** An existing row of this contact to keep and update. Without it, an identical row is kept, else a new one is added. */
    id: Type.Optional(Type.Integer({ minimum: 1 })),
    type: Type.Optional(addressType),
    typeLabel: Type.Optional(Type.Union([Type.String({ maxLength: 50 }), Type.Null()])),
    line1: Type.Optional(Type.String({ maxLength: 255 })),
    line2: Type.Optional(Type.String({ maxLength: 255 })),
    city: Type.Optional(Type.String({ maxLength: 100 })),
    state: Type.Optional(Type.String({ maxLength: 25 })),
    zip: Type.Optional(Type.String({ maxLength: 15 })),
    isPrimary: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
)

export const replacePhonesBody = Type.Object(
  { phones: Type.Array(phoneInput) },
  { additionalProperties: false },
)
export const replaceEmailsBody = Type.Object(
  { emails: Type.Array(emailInput) },
  { additionalProperties: false },
)
export const replaceAddressesBody = Type.Object(
  { addresses: Type.Array(addressInput) },
  { additionalProperties: false },
)

export const contactWriteResult = Type.Object(
  {
    contact: contactDetail,
    affected_child_ids: Type.Array(Type.Integer()),
  },
  { additionalProperties: false },
)

export type ContactPage = Type.Static<typeof contactPage>
export type ContactDetail = Type.Static<typeof contactDetail>
export type PatchContactBody = Type.Static<typeof patchContactBody>
export type ReplacePhonesBody = Type.Static<typeof replacePhonesBody>
export type ReplaceEmailsBody = Type.Static<typeof replaceEmailsBody>
export type ReplaceAddressesBody = Type.Static<typeof replaceAddressesBody>
export type ContactWriteResult = Type.Static<typeof contactWriteResult>
