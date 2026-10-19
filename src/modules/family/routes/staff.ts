// GET /staff/me: the signed-in staff member, as the auth preHandler resolved them. The Families
// screens use it to know the user's admin.type.

import Type from 'typebox';
import type { FastifyInstance } from 'fastify';

const StaffMember = Type.Object(
  {
    adminId: Type.Integer(),
    type: Type.String({ description: 'admin.type' }),
    name: Type.String(),
  },
  { $id: 'StaffMember' },
);

export function registerStaffRoutes(app: FastifyInstance): void {
  app.get(
    '/staff/me',
    {
      schema: {
        tags: ['family'],
        summary: 'The signed-in staff member (bearer token)',
        security: [{ bearerAuth: [] }],
        response: {
          200: StaffMember,
          401: Type.Ref('ErrorResponse'),
          403: Type.Ref('ErrorResponse'),
        },
      },
    },
    async (request) => request.staff,
  );
}
