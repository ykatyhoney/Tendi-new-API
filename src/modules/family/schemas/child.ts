import { Type } from '@fastify/type-provider-typebox'
import { model } from './models.js'

/**
 * GET /api/v1/children: the legacy children table, read only. The API never creates a child; new children come
 * from the legacy registration. Trashed children are never listed.
 */
export const childListQuery = Type.Object({
  q: Type.Optional(
    Type.String({ maxLength: 100, description: 'First name, last name, "first last", or the exact child id.' }),
  ),
  status: Type.Union([Type.Literal('active'), Type.Literal('inactive'), Type.Literal('all')], {
    default: 'active',
    description: "children.status. 'all' is active and inactive; trashed children are never listed.",
  }),
  linked: Type.Union([Type.Literal('all'), Type.Literal('yes'), Type.Literal('no')], {
    default: 'all',
    description: "'yes': children.family_id is set. 'no': it is NULL.",
  }),
  page: Type.Integer({ minimum: 1, default: 1 }),
  pageSize: Type.Integer({ minimum: 1, maximum: 100, default: 25 }),
})

const childListItemDefinition = Type.Object(
  {
    id: Type.Integer(),
    fname: Type.String(),
    lname: Type.String(),
    className: Type.String({ description: "The class's friendly name, else its name; '' when the class is not on file." }),
    status: Type.Union([Type.Literal('active'), Type.Literal('inactive')]),
    enrollmentStatus: Type.String({ description: 'children.enrollment_status, for example enrolled or waitlist.' }),
    dob: Type.Union([Type.String(), Type.Null()], { description: 'YYYY-MM-DD; null for an empty or zero date.' }),
    familyId: Type.Union([Type.Integer(), Type.Null()]),
    familyName: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
)
export const childListItem = model('ChildListItem', childListItemDefinition)

const childPageDefinition = Type.Object(
  {
    items: Type.Array(childListItem),
    page: Type.Integer(),
    pageSize: Type.Integer(),
    total: Type.Integer(),
  },
  { additionalProperties: false },
)
export const childPage = model('ChildPage', childPageDefinition)

export type ChildListQuery = Type.Static<typeof childListQuery>
export type ChildListItem = Type.Static<typeof childListItem>
export type ChildPage = Type.Static<typeof childPage>
