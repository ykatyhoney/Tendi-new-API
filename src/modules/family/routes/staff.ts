// GET /staff/me: the signed-in staff member, as the auth preHandler resolved them. The Families
// screens use it to know the user's admin.type.

import Type from 'typebox';
import type { FastifyInstance } from 'fastify';
import { FAMILY_TAG, errorResponses } from './common.ts';

export function registerStaffRoutes(app: FastifyInstance): void {
  app.get(
    '/staff/me',
    {
      schema: {
        operationId: 'getCurrentStaff',
        tags: [FAMILY_TAG],
        summary: 'The signed-in staff member (bearer token)',
        security: [{ bearerAuth: [] }],
        response: { 200: Type.Ref('StaffMember'), ...errorResponses(401, 403) },
      },
    },
    async (request) => {
      const staff = request.staff!;
      return { admin_id: staff.adminId, type: staff.type, name: staff.name };
    },
  );
}
