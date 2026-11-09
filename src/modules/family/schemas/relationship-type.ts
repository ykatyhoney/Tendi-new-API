import { Type } from '@fastify/type-provider-typebox'

const relationshipType = Type.Object(
  {
    code: Type.String(),
    label: Type.String(),
    parentSlot: Type.Union([Type.Literal('father'), Type.Literal('mother'), Type.Null()]),
    slotRank: Type.Union([Type.Integer(), Type.Null()]),
    sortOrder: Type.Integer(),
    status: Type.Literal('active'),
  },
  { additionalProperties: false },
)

export const relationshipTypeList = Type.Object(
  {
    items: Type.Array(relationshipType),
  },
  { additionalProperties: false },
)

const storedRelationshipType = Type.Object(
  {
    code: Type.String(),
    label: Type.String(),
    parentSlot: Type.Union([Type.Literal('father'), Type.Literal('mother'), Type.Null()]),
    slotRank: Type.Union([Type.Integer(), Type.Null()]),
    sortOrder: Type.Integer(),
    status: Type.Union([Type.Literal('active'), Type.Literal('inactive')]),
  },
  { additionalProperties: false },
)

export const relationshipTypeParams = Type.Object({
  code: Type.String({ minLength: 1, maxLength: 32, pattern: '^[a-z_]+$' }),
})

export const createRelationshipTypeBody = Type.Object(
  {
    code: Type.String({ minLength: 1, maxLength: 32, pattern: '^[a-z_]+$' }),
    label: Type.String({ minLength: 1, maxLength: 64 }),
    sortOrder: Type.Integer(),
  },
  { additionalProperties: false },
)

export const patchRelationshipTypeBody = Type.Object(
  {
    label: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    sortOrder: Type.Optional(Type.Integer()),
    status: Type.Optional(Type.Union([Type.Literal('active'), Type.Literal('inactive')])),
  },
  { additionalProperties: false },
)

export const relationshipTypeResult = Type.Object(
  {
    relationshipType: storedRelationshipType,
    affected_child_ids: Type.Array(Type.Integer()),
  },
  { additionalProperties: false },
)

export type RelationshipTypeList = Type.Static<typeof relationshipTypeList>
export type CreateRelationshipTypeBody = Type.Static<typeof createRelationshipTypeBody>
export type PatchRelationshipTypeBody = Type.Static<typeof patchRelationshipTypeBody>
export type RelationshipTypeResult = Type.Static<typeof relationshipTypeResult>
