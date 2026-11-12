import { Type } from '@fastify/type-provider-typebox'
import { model } from './models.js'

/** GET /api/v1/staff/me: who the bearer token belongs to, for the screens to decide what to show. */
const staffMeDefinition = Type.Object(
  {
    adminId: Type.Integer(),
    name: Type.String(),
    type: Type.String({ description: 'admin.type, lowercased and trimmed.' }),
    relationshipAdmin: Type.Boolean({ description: 'May add and change relationship types.' }),
  },
  { additionalProperties: false },
)
export const staffMe = model('StaffMe', staffMeDefinition)

export type StaffMe = Type.Static<typeof staffMe>
