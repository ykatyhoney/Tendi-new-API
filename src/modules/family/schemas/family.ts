import { Type } from '@fastify/type-provider-typebox'

export const familySearchQuery = Type.Object({
  q: Type.Optional(Type.String({ maxLength: 100 })),
  page: Type.Integer({ minimum: 1, default: 1 }),
  pageSize: Type.Integer({ minimum: 1, maximum: 100, default: 25 }),
})

const searchMember = Type.Object(
  {
    name: Type.String(),
    relationship: Type.String(),
    relationshipLabel: Type.String(),
  },
  { additionalProperties: false },
)

const searchChild = Type.Object(
  {
    id: Type.Integer(),
    fname: Type.String(),
    lname: Type.String(),
    class: Type.Integer(),
  },
  { additionalProperties: false },
)

const familySummary = Type.Object(
  {
    id: Type.Integer(),
    name: Type.String(),
    householdPhone: Type.String(),
    members: Type.Array(searchMember),
    children: Type.Array(searchChild),
    memberCount: Type.Integer(),
    childCount: Type.Integer(),
  },
  { additionalProperties: false },
)

export const familyPage = Type.Object(
  {
    items: Type.Array(familySummary),
    page: Type.Integer(),
    pageSize: Type.Integer(),
    total: Type.Integer(),
  },
  { additionalProperties: false },
)

const phone = Type.Object(
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
)

const email = Type.Object(
  {
    id: Type.Integer(),
    email: Type.String(),
    type: Type.Union([Type.Literal('personal'), Type.Literal('work'), Type.Literal('other')]),
    typeLabel: Type.Union([Type.String(), Type.Null()]),
    isPrimary: Type.Boolean(),
    sortOrder: Type.Integer(),
  },
  { additionalProperties: false },
)

const address = Type.Object(
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
)

const contactCard = Type.Object(
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
  },
  { additionalProperties: false },
)

const rights = Type.Object(
  {
    id: Type.Integer(),
    childId: Type.Integer(),
    receivesNotifications: Type.Boolean(),
    notifyMethod: Type.Union([Type.Literal('sms'), Type.Literal('voice'), Type.Literal('both')]),
    mayCollect: Type.Boolean(),
    collectFrom: Type.Union([Type.String(), Type.Null()]),
    collectTo: Type.Union([Type.String(), Type.Null()]),
    isEmergency: Type.Boolean(),
    isPaymentResponsible: Type.Boolean(),
  },
  { additionalProperties: false },
)

const member = Type.Object(
  {
    id: Type.Integer(),
    relationship: Type.String(),
    relationshipLabel: Type.String(),
    isPrimary: Type.Boolean(),
    sortOrder: Type.Integer(),
    contact: contactCard,
    rights: Type.Array(rights),
  },
  { additionalProperties: false },
)

export const familyDetail = Type.Object(
  {
    id: Type.Integer(),
    name: Type.String(),
    householdPhone: Type.String(),
    status: Type.Union([Type.Literal('active'), Type.Literal('trash')]),
    members: Type.Array(member),
    children: Type.Array(searchChild),
  },
  { additionalProperties: false },
)

export const familyParams = Type.Object({
  id: Type.Integer({ minimum: 1 }),
})

export const memberParams = Type.Object({
  id: Type.Integer({ minimum: 1 }),
  memberId: Type.Integer({ minimum: 1 }),
})

export const familyWriteResult = Type.Object(
  {
    family: familyDetail,
    affected_child_ids: Type.Array(Type.Integer()),
  },
  { additionalProperties: false },
)

const newContact = Type.Object(
  {
    fname: Type.String({ maxLength: 100 }),
    lname: Type.String({ maxLength: 100 }),
    hebrewName: Type.Optional(Type.String({ maxLength: 255 })),
    occupation: Type.Optional(Type.String({ maxLength: 150 })),
    employer: Type.Optional(Type.String({ maxLength: 150 })),
    note: Type.Optional(Type.Union([Type.String({ maxLength: 20000 }), Type.Null()])),
  },
  { additionalProperties: false },
)

export const createFamilyBody = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 100 }),
    householdPhone: Type.Optional(Type.String({ maxLength: 255 })),
  },
  { additionalProperties: false },
)

export const patchFamilyBody = Type.Object(
  {
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
    householdPhone: Type.Optional(Type.String({ maxLength: 255 })),
    status: Type.Optional(Type.Union([Type.Literal('active'), Type.Literal('trash')])),
  },
  { additionalProperties: false },
)

export const createMemberBody = Type.Union([
  Type.Object(
    {
      relationship: Type.String({ minLength: 1, maxLength: 32 }),
      isPrimary: Type.Optional(Type.Boolean()),
      sortOrder: Type.Optional(Type.Integer()),
      contactId: Type.Integer({ minimum: 1 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      relationship: Type.String({ minLength: 1, maxLength: 32 }),
      isPrimary: Type.Optional(Type.Boolean()),
      sortOrder: Type.Optional(Type.Integer()),
      contact: newContact,
    },
    { additionalProperties: false },
  ),
])

export const patchMemberBody = Type.Object(
  {
    relationship: Type.Optional(Type.String({ minLength: 1, maxLength: 32 })),
    isPrimary: Type.Optional(Type.Boolean()),
    sortOrder: Type.Optional(Type.Integer()),
  },
  { additionalProperties: false },
)

export type CreateFamilyBody = Type.Static<typeof createFamilyBody>
export type PatchFamilyBody = Type.Static<typeof patchFamilyBody>
export type CreateMemberBody = Type.Static<typeof createMemberBody>
export type PatchMemberBody = Type.Static<typeof patchMemberBody>
export type FamilyWriteResult = Type.Static<typeof familyWriteResult>

export const childFamily = Type.Object(
  {
    link: Type.Union([Type.Literal('linked'), Type.Literal('draft')]),
    family: familyDetail,
  },
  { additionalProperties: false },
)

export const childParams = Type.Object({
  childId: Type.Integer({ minimum: 1 }),
})

export type FamilySearchQuery = Type.Static<typeof familySearchQuery>
export type FamilyPage = Type.Static<typeof familyPage>
export type FamilyDetail = Type.Static<typeof familyDetail>
export type ChildFamily = Type.Static<typeof childFamily>
export type ContactCard = Type.Static<typeof contactCard>
export type PhoneRow = Type.Static<typeof phone>
export type EmailRow = Type.Static<typeof email>
export type AddressRow = Type.Static<typeof address>
export type RightsRow = Type.Static<typeof rights>
