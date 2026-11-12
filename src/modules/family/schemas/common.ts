import { Type } from '@fastify/type-provider-typebox'
import { OLD_COLUMN_LIMITS } from './limits.js'
import { model } from './models.js'

/*
 * Shapes used by more than one resource. Each enum matches the column's ENUM in tendi_family_module.sql.
 * Contacts, families, the mirror, and the repositories all take their types from here.
 */

const phoneTypeDefinition = Type.Union([
  Type.Literal('mobile'),
  Type.Literal('home'),
  Type.Literal('work'),
  Type.Literal('other'),
])
export const phoneType = model('PhoneType', phoneTypeDefinition)

const phoneChannelDefinition = Type.Union([
  Type.Literal('none'),
  Type.Literal('sms'),
  Type.Literal('voice'),
  Type.Literal('both'),
])
export const phoneChannel = model('PhoneChannel', phoneChannelDefinition)

const emailTypeDefinition = Type.Union([Type.Literal('personal'), Type.Literal('work'), Type.Literal('other')])
export const emailType = model('EmailType', emailTypeDefinition)

const addressTypeDefinition = Type.Union([
  Type.Literal('home'),
  Type.Literal('work'),
  Type.Literal('billing'),
  Type.Literal('other'),
])
export const addressType = model('AddressType', addressTypeDefinition)

const notifyMethodDefinition = Type.Union([Type.Literal('sms'), Type.Literal('voice'), Type.Literal('both')])
export const notifyMethod = model('NotifyMethod', notifyMethodDefinition)

const recordStatusDefinition = Type.Union([Type.Literal('active'), Type.Literal('trash')])
export const recordStatus = model('RecordStatus', recordStatusDefinition)

/** sort_order columns are int(11). A value outside this range is a 400, not a database error. */
export const sortOrder = Type.Integer({ minimum: -2147483648, maximum: 2147483647 })

/**
 * A JSON Schema pattern for a required text: at least one character that is not white space. minLength alone
 * accepts "   ", which would be saved as a family with no visible name, or mirrored as a blank phone.
 */
export const NOT_BLANK = '\\S'

const phoneDefinition = Type.Object(
  {
    id: Type.Integer(),
    phone: Type.String(),
    type: phoneType,
    typeLabel: Type.Union([Type.String(), Type.Null()]),
    channel: phoneChannel,
    isPrimary: Type.Boolean(),
    sortOrder: Type.Integer(),
  },
  { additionalProperties: false },
)
export const phone = model('Phone', phoneDefinition)

const emailDefinition = Type.Object(
  {
    id: Type.Integer(),
    email: Type.String(),
    type: emailType,
    typeLabel: Type.Union([Type.String(), Type.Null()]),
    isPrimary: Type.Boolean(),
    sortOrder: Type.Integer(),
  },
  { additionalProperties: false },
)
export const email = model('Email', emailDefinition)

const addressDefinition = Type.Object(
  {
    id: Type.Integer(),
    type: addressType,
    typeLabel: Type.Union([Type.String(), Type.Null()]),
    line1: Type.String(),
    line2: Type.String(),
    city: Type.String(),
    state: Type.String(),
    zip: Type.String(),
    isPrimary: Type.Boolean(),
  },
  { additionalProperties: false },
)
export const address = model('Address', addressDefinition)

/** A new contact's fields. The service trims names and requires a first or last name. */
const newContactDefinition = Type.Object(
  {
    fname: Type.String({ maxLength: OLD_COLUMN_LIMITS.name }),
    lname: Type.String({ maxLength: OLD_COLUMN_LIMITS.name }),
    hebrewName: Type.Optional(Type.String({ maxLength: 255 })),
    occupation: Type.Optional(Type.String({ maxLength: OLD_COLUMN_LIMITS.occupation })),
    employer: Type.Optional(Type.String({ maxLength: OLD_COLUMN_LIMITS.employer })),
    note: Type.Optional(Type.Union([Type.String({ maxLength: 20000 }), Type.Null()])),
  },
  { additionalProperties: false },
)
export const newContact = model('NewContact', newContactDefinition)

/**
 * Optional body of a member removal or a link. allowEmptyParents saves even when the linked children would be
 * left with no member in the father or mother slot (otherwise 409 NO_PARENT_SLOT). No body is the same as {}.
 */
export const emptyParentsOption = Type.Boolean({
  description: 'Save even if the linked children are left with both parent slots empty (otherwise 409 NO_PARENT_SLOT).',
})

export const emptyParentsBody = Type.Union([
  Type.Object({ allowEmptyParents: Type.Optional(emptyParentsOption) }, { additionalProperties: false }),
  Type.Null(),
])

export const searchQuery = Type.Object({
  q: Type.Optional(Type.String({ maxLength: 100 })),
  page: Type.Integer({ minimum: 1, default: 1 }),
  pageSize: Type.Integer({ minimum: 1, maximum: 100, default: 25 }),
})

export type PhoneType = Type.Static<typeof phoneType>
export type PhoneChannel = Type.Static<typeof phoneChannel>
export type EmailType = Type.Static<typeof emailType>
export type AddressType = Type.Static<typeof addressType>
export type NotifyMethod = Type.Static<typeof notifyMethod>
export type RecordStatus = Type.Static<typeof recordStatus>
export type PhoneOutput = Type.Static<typeof phone>
export type EmailOutput = Type.Static<typeof email>
export type AddressOutput = Type.Static<typeof address>
export type NewContact = Type.Static<typeof newContact>
export type SearchQuery = Type.Static<typeof searchQuery>
export type EmptyParentsBody = Type.Static<typeof emptyParentsBody>
