import { Type } from '@fastify/type-provider-typebox'
import {
  address,
  email,
  emptyParentsBody,
  emptyParentsOption,
  newContact,
  NOT_BLANK,
  notifyMethod,
  phone,
  recordStatus,
  searchQuery,
  sortOrder,
} from './common.js'
import { OLD_COLUMN_LIMITS } from './limits.js'
import { model } from './models.js'

export const familySearchQuery = searchQuery

const mirrorSlot = Type.Union([Type.Literal('father'), Type.Literal('mother'), Type.Null()], {
  description:
    "The old parent columns this member fills on the family's linked children, picked by the mirror's own rule. Null for every other member.",
})

const searchMemberDefinition = Type.Object(
  {
    name: Type.String(),
    relationship: Type.String(),
    relationshipLabel: Type.String(),
    mirrorSlot,
  },
  { additionalProperties: false },
)
const searchMember = model('FamilySummaryMember', searchMemberDefinition)

const searchChildDefinition = Type.Object(
  {
    id: Type.Integer(),
    fname: Type.String(),
    lname: Type.String(),
    class: Type.Integer(),
    status: Type.Union([Type.Literal('active'), Type.Literal('inactive'), Type.Literal('trash')], {
      description:
        "children.status. 'trash' appears only in a family's own children: a child trashed in the main admin stays linked (and mirrored) until it is unlinked, and the family cannot be archived before that. The family list leaves trashed children out.",
    }),
  },
  { additionalProperties: false },
)
const searchChild = model('ChildSummary', searchChildDefinition)

const familySummaryDefinition = Type.Object(
  {
    id: Type.Integer(),
    name: Type.String(),
    householdPhone: Type.String(),
    address: Type.String({
      description:
        "The main contact's home address (primary first), joined as the mirror joins it; '' when there is none.",
    }),
    members: Type.Array(searchMember),
    children: Type.Array(searchChild),
    memberCount: Type.Integer(),
    childCount: Type.Integer(),
  },
  { additionalProperties: false },
)
const familySummary = model('FamilySummary', familySummaryDefinition)

const familyPageDefinition = Type.Object(
  {
    items: Type.Array(familySummary),
    page: Type.Integer(),
    pageSize: Type.Integer(),
    total: Type.Integer(),
  },
  { additionalProperties: false },
)
export const familyPage = model('FamilyPage', familyPageDefinition)

const contactCardDefinition = Type.Object(
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
const contactCard = model('MemberContact', contactCardDefinition)

const rightsDefinition = Type.Object(
  {
    id: Type.Integer(),
    childId: Type.Integer(),
    receivesNotifications: Type.Boolean(),
    notifyMethod,
    mayCollect: Type.Boolean(),
    collectFrom: Type.Union([Type.String(), Type.Null()]),
    collectTo: Type.Union([Type.String(), Type.Null()]),
    isEmergency: Type.Boolean(),
    isPaymentResponsible: Type.Boolean(),
  },
  { additionalProperties: false },
)
const rights = model('MemberRights', rightsDefinition)

const memberDefinition = Type.Object(
  {
    id: Type.Integer(),
    relationship: Type.String(),
    relationshipLabel: Type.String(),
    mirrorSlot,
    isPrimary: Type.Boolean(),
    sortOrder: Type.Integer(),
    contact: contactCard,
    rights: Type.Array(rights),
  },
  { additionalProperties: false },
)
const member = model('FamilyMember', memberDefinition)

const familyDetailDefinition = Type.Object(
  {
    id: Type.Integer(),
    name: Type.String(),
    householdPhone: Type.String(),
    status: recordStatus,
    members: Type.Array(member),
    children: Type.Array(searchChild),
  },
  { additionalProperties: false },
)
export const familyDetail = model('Family', familyDetailDefinition)

export const familyParams = Type.Object({
  id: Type.Integer({ minimum: 1 }),
})

export const memberParams = Type.Object({
  id: Type.Integer({ minimum: 1 }),
  memberId: Type.Integer({ minimum: 1 }),
})

const familyWriteResultDefinition = Type.Object(
  {
    family: familyDetail,
    affected_child_ids: Type.Array(Type.Integer()),
  },
  { additionalProperties: false },
)
export const familyWriteResult = model('FamilyWriteResult', familyWriteResultDefinition)

const createFamilyBodyDefinition = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 100, pattern: NOT_BLANK }),
    householdPhone: Type.Optional(Type.String({ maxLength: OLD_COLUMN_LIMITS.phone })),
  },
  { additionalProperties: false },
)
export const createFamilyBody = model('CreateFamilyBody', createFamilyBodyDefinition)

const patchFamilyBodyDefinition = Type.Object(
  {
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 100, pattern: NOT_BLANK })),
    householdPhone: Type.Optional(Type.String({ maxLength: OLD_COLUMN_LIMITS.phone })),
    status: Type.Optional(recordStatus),
  },
  { additionalProperties: false },
)
export const patchFamilyBody = model('PatchFamilyBody', patchFamilyBodyDefinition)

const createMemberBodyDefinition = Type.Union([
  Type.Object(
    {
      relationship: Type.String({ minLength: 1, maxLength: 32 }),
      isPrimary: Type.Optional(Type.Boolean()),
      sortOrder: Type.Optional(sortOrder),
      contactId: Type.Integer({ minimum: 1 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      relationship: Type.String({ minLength: 1, maxLength: 32 }),
      isPrimary: Type.Optional(Type.Boolean()),
      sortOrder: Type.Optional(sortOrder),
      contact: newContact,
    },
    { additionalProperties: false },
  ),
])
export const createMemberBody = model('CreateMemberBody', createMemberBodyDefinition)

const patchMemberBodyDefinition = Type.Object(
  {
    relationship: Type.Optional(Type.String({ minLength: 1, maxLength: 32 })),
    isPrimary: Type.Optional(Type.Boolean()),
    sortOrder: Type.Optional(sortOrder),
    allowEmptyParents: Type.Optional(emptyParentsOption),
  },
  { additionalProperties: false },
)
export const patchMemberBody = model('PatchMemberBody', patchMemberBodyDefinition)

/** DELETE /families/:id/members/:memberId: an optional { allowEmptyParents }. */
export const deleteMemberBody = emptyParentsBody

export type CreateFamilyBody = Type.Static<typeof createFamilyBody>
export type PatchFamilyBody = Type.Static<typeof patchFamilyBody>
export type CreateMemberBody = Type.Static<typeof createMemberBody>
export type PatchMemberBody = Type.Static<typeof patchMemberBody>
export type FamilyWriteResult = Type.Static<typeof familyWriteResult>

const childFamilyDefinition = Type.Object(
  {
    link: Type.Union([Type.Literal('linked'), Type.Literal('draft')]),
    family: familyDetail,
  },
  { additionalProperties: false },
)
export const childFamily = model('ChildFamily', childFamilyDefinition)

export const childParams = Type.Object({
  childId: Type.Integer({ minimum: 1 }),
})

export type FamilySearchQuery = Type.Static<typeof familySearchQuery>
export type FamilyPage = Type.Static<typeof familyPage>
export type FamilyDetail = Type.Static<typeof familyDetail>
export type ChildFamily = Type.Static<typeof childFamily>
export type ContactCard = Type.Static<typeof contactCard>
export type RightsOutput = Type.Static<typeof rights>
