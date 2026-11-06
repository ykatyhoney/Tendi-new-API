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

export type RelationshipTypeList = Type.Static<typeof relationshipTypeList>
