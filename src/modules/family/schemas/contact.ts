import { Type } from '@fastify/type-provider-typebox'
import { familySearchQuery } from './family.js'

const contactPhone = Type.Object(
  {
    phone: Type.String(),
    type: Type.Union([
      Type.Literal('mobile'),
      Type.Literal('home'),
      Type.Literal('work'),
      Type.Literal('other'),
    ]),
    isPrimary: Type.Boolean(),
  },
  { additionalProperties: false },
)

const household = Type.Object(
  {
    familyId: Type.Integer(),
    familyName: Type.String(),
    familyStatus: Type.Union([Type.Literal('active'), Type.Literal('trash')]),
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

export const contactSearchQuery = familySearchQuery

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
    phones: Type.Array(
      Type.Object(
        {
          id: Type.Integer(),
          phone: Type.String(),
          type: Type.Union([
            Type.Literal('mobile'),
            Type.Literal('home'),
            Type.Literal('work'),
            Type.Literal('other'),
          ]),
          typeLabel: Type.Union([Type.String(), Type.Null()]),
          channel: Type.Union([
            Type.Literal('none'),
            Type.Literal('sms'),
            Type.Literal('voice'),
            Type.Literal('both'),
          ]),
          isPrimary: Type.Boolean(),
          sortOrder: Type.Integer(),
        },
        { additionalProperties: false },
      ),
    ),
    emails: Type.Array(
      Type.Object(
        {
          id: Type.Integer(),
          email: Type.String(),
          type: Type.Union([Type.Literal('personal'), Type.Literal('work'), Type.Literal('other')]),
          typeLabel: Type.Union([Type.String(), Type.Null()]),
          isPrimary: Type.Boolean(),
          sortOrder: Type.Integer(),
        },
        { additionalProperties: false },
      ),
    ),
    addresses: Type.Array(
      Type.Object(
        {
          id: Type.Integer(),
          type: Type.Union([
            Type.Literal('home'),
            Type.Literal('work'),
            Type.Literal('billing'),
            Type.Literal('other'),
          ]),
          typeLabel: Type.Union([Type.String(), Type.Null()]),
          line1: Type.String(),
          line2: Type.String(),
          city: Type.String(),
          state: Type.String(),
          zip: Type.String(),
          isPrimary: Type.Boolean(),
        },
        { additionalProperties: false },
      ),
    ),
    households: Type.Array(household),
  },
  { additionalProperties: false },
)

export const contactParams = Type.Object({
  id: Type.Integer({ minimum: 1 }),
})

export const patchContactBody = Type.Object(
  {
    fname: Type.Optional(Type.String({ maxLength: 100 })),
    lname: Type.Optional(Type.String({ maxLength: 100 })),
    hebrewName: Type.Optional(Type.String({ maxLength: 255 })),
    occupation: Type.Optional(Type.String({ maxLength: 150 })),
    employer: Type.Optional(Type.String({ maxLength: 150 })),
    note: Type.Optional(Type.Union([Type.String({ maxLength: 20000 }), Type.Null()])),
  },
  { additionalProperties: false },
)

const phoneInput = Type.Object(
  {
    phone: Type.String({ minLength: 1, maxLength: 255 }),
    type: Type.Optional(
      Type.Union([Type.Literal('mobile'), Type.Literal('home'), Type.Literal('work'), Type.Literal('other')]),
    ),
    typeLabel: Type.Optional(Type.Union([Type.String({ maxLength: 50 }), Type.Null()])),
    channel: Type.Optional(
      Type.Union([Type.Literal('none'), Type.Literal('sms'), Type.Literal('voice'), Type.Literal('both')]),
    ),
    isPrimary: Type.Optional(Type.Boolean()),
    sortOrder: Type.Optional(Type.Integer()),
  },
  { additionalProperties: false },
)

const emailInput = Type.Object(
  {
    email: Type.String({ minLength: 1, maxLength: 255 }),
    type: Type.Optional(Type.Union([Type.Literal('personal'), Type.Literal('work'), Type.Literal('other')])),
    typeLabel: Type.Optional(Type.Union([Type.String({ maxLength: 50 }), Type.Null()])),
    isPrimary: Type.Optional(Type.Boolean()),
    sortOrder: Type.Optional(Type.Integer()),
  },
  { additionalProperties: false },
)

const addressInput = Type.Object(
  {
    type: Type.Optional(
      Type.Union([Type.Literal('home'), Type.Literal('work'), Type.Literal('billing'), Type.Literal('other')]),
    ),
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
