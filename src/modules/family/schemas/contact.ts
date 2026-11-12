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
import { model } from './models.js'

const contactPhoneDefinition = Type.Object(
  {
    phone: Type.String(),
    type: phoneType,
    isPrimary: Type.Boolean(),
  },
  { additionalProperties: false },
)
const contactPhone = model('ContactSummaryPhone', contactPhoneDefinition)

const householdDefinition = Type.Object(
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
const household = model('ContactHousehold', householdDefinition)

const contactSummaryDefinition = Type.Object(
  {
    id: Type.Integer(),
    fname: Type.String(),
    lname: Type.String(),
    legacyFullName: Type.String(),
    phones: Type.Array(contactPhone),
    households: Type.Array(
      Type.Object(
        {
          familyId: Type.Integer(),
          familyName: Type.String(),
          relationship: Type.String(),
          relationshipLabel: Type.String(),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
)
const contactSummary = model('ContactSummary', contactSummaryDefinition)

export const contactSearchQuery = Type.Object({
  ...searchQuery.properties,
  relationship: Type.Optional(
    Type.String({
      maxLength: 1000,
      pattern: '^[a-z][a-z_]*(,[a-z][a-z_]*)*$',
      description:
        'Comma-separated relationship codes. Only contacts who hold one of them in an active household are listed.',
    }),
  ),
})

export type ContactSearchQuery = Type.Static<typeof contactSearchQuery>

const contactPageDefinition = Type.Object(
  {
    items: Type.Array(contactSummary),
    page: Type.Integer(),
    pageSize: Type.Integer(),
    total: Type.Integer(),
  },
  { additionalProperties: false },
)
export const contactPage = model('ContactPage', contactPageDefinition)

const contactDetailDefinition = Type.Object(
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
export const contactDetail = model('Contact', contactDetailDefinition)

export const contactParams = Type.Object({
  id: Type.Integer({ minimum: 1 }),
})

const patchContactBodyDefinition = Type.Object(
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
export const patchContactBody = model('PatchContactBody', patchContactBodyDefinition)

const phoneInputDefinition = Type.Object(
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
const phoneInput = model('PhoneInput', phoneInputDefinition)

const emailInputDefinition = Type.Object(
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
const emailInput = model('EmailInput', emailInputDefinition)

const addressInputDefinition = Type.Object(
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
const addressInput = model('AddressInput', addressInputDefinition)

const replacePhonesBodyDefinition = Type.Object(
  { phones: Type.Array(phoneInput) },
  { additionalProperties: false },
)
export const replacePhonesBody = model('ReplacePhonesBody', replacePhonesBodyDefinition)
const replaceEmailsBodyDefinition = Type.Object(
  { emails: Type.Array(emailInput) },
  { additionalProperties: false },
)
export const replaceEmailsBody = model('ReplaceEmailsBody', replaceEmailsBodyDefinition)
const replaceAddressesBodyDefinition = Type.Object(
  { addresses: Type.Array(addressInput) },
  { additionalProperties: false },
)
export const replaceAddressesBody = model('ReplaceAddressesBody', replaceAddressesBodyDefinition)

const contactWriteResultDefinition = Type.Object(
  {
    contact: contactDetail,
    affected_child_ids: Type.Array(Type.Integer()),
  },
  { additionalProperties: false },
)
export const contactWriteResult = model('ContactWriteResult', contactWriteResultDefinition)

export type ContactPage = Type.Static<typeof contactPage>
export type ContactDetail = Type.Static<typeof contactDetail>
export type PatchContactBody = Type.Static<typeof patchContactBody>
export type ReplacePhonesBody = Type.Static<typeof replacePhonesBody>
export type ReplaceEmailsBody = Type.Static<typeof replaceEmailsBody>
export type ReplaceAddressesBody = Type.Static<typeof replaceAddressesBody>
export type ContactWriteResult = Type.Static<typeof contactWriteResult>
