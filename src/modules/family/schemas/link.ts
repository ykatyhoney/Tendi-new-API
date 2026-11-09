import { Type } from '@fastify/type-provider-typebox'
import { emptyParentsBody, notifyMethod } from './common.js'

/** POST .../link: an optional { allowEmptyParents }. */
export const linkBody = emptyParentsBody

export const familyChildParams = Type.Object({
  id: Type.Integer({ minimum: 1 }),
  childId: Type.Integer({ minimum: 1 }),
})

const legacyCell = Type.Union([Type.String(), Type.Integer(), Type.Null()])

const previewColumn = Type.Object(
  {
    column: Type.String(),
    table: Type.Union([Type.Literal('children'), Type.Literal('children_additional_information')]),
    today: legacyCell,
    after: legacyCell,
    changed: Type.Boolean(),
    tooLong: Type.Boolean(),
  },
  { additionalProperties: false },
)

export const linkPreview = Type.Object(
  {
    childId: Type.Integer(),
    familyId: Type.Integer(),
    currentFamilyId: Type.Union([Type.Integer(), Type.Null()]),
    columns: Type.Array(previewColumn),
  },
  { additionalProperties: false },
)

export const linkResult = Type.Object(
  {
    childId: Type.Integer(),
    familyId: Type.Integer(),
    affected_child_ids: Type.Array(Type.Integer()),
  },
  { additionalProperties: false },
)

export const unlinkResult = Type.Object(
  {
    childId: Type.Integer(),
    familyId: Type.Null(),
    affected_child_ids: Type.Array(Type.Integer()),
  },
  { additionalProperties: false },
)

const rightsInput = Type.Object(
  {
    memberId: Type.Integer({ minimum: 1 }),
    receivesNotifications: Type.Boolean(),
    notifyMethod,
    mayCollect: Type.Boolean(),
    collectFrom: Type.Union([Type.String({ format: 'date' }), Type.Null()]),
    collectTo: Type.Union([Type.String({ format: 'date' }), Type.Null()]),
    isEmergency: Type.Boolean(),
    isPaymentResponsible: Type.Boolean(),
  },
  { additionalProperties: false },
)

export const replaceRightsBody = Type.Object(
  { rights: Type.Array(rightsInput) },
  { additionalProperties: false },
)

const rightsOutput = Type.Object(
  {
    id: Type.Integer(),
    memberId: Type.Integer(),
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

export const rightsResult = Type.Object(
  {
    familyId: Type.Integer(),
    childId: Type.Integer(),
    rights: Type.Array(rightsOutput),
    affected_child_ids: Type.Array(Type.Integer()),
  },
  { additionalProperties: false },
)

export type LinkPreview = Type.Static<typeof linkPreview>
export type LinkResult = Type.Static<typeof linkResult>
export type UnlinkResult = Type.Static<typeof unlinkResult>
export type ReplaceRightsBody = Type.Static<typeof replaceRightsBody>
export type RightsResult = Type.Static<typeof rightsResult>
