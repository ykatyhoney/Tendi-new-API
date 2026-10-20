// Family module (PLAN.md "Family API"): its own config, pool (family_api), service layer and
// repository layer. Routes live in routes/ and register here; the Family API routes
// (/families, /people/:id, /children/:childId/unlink, ...) are added in the following steps.
//
// Layers: routes/ (HTTP: schemas, status codes) -> service/ (rules, familyDb.transaction for every
// write) -> repository/ (SQL only, on a Queryable). Nothing here caches family data (MVP).
//
// Every Family API route registers inside the protected scope below, so it runs behind the staff
// auth onRequest hook (bearer token, active admin, allowed staff type) and has request.staff.
// Only GET /health/family is public.

import type { FastifyInstance } from 'fastify';
import { protectScope } from './auth.ts';
import { loadFamilyConfig } from './config.ts';
import { createFamilyDb } from './db.ts';
import { registerChildrenRoutes } from './routes/children.ts';
import { registerFamilyRoutes } from './routes/families.ts';
import { registerHealthRoutes } from './routes/health.ts';
import { registerPeopleRoutes } from './routes/people.ts';
import { registerStaffRoutes } from './routes/staff.ts';

export { familySchemas } from './schemas/models.ts';

export default async function familyModule(app: FastifyInstance): Promise<void> {
  const config = loadFamilyConfig();
  const db = createFamilyDb(app.config.db, config);
  app.addHook('onClose', async () => {
    await db.pool.end();
  });

  registerHealthRoutes(app, db);

  await app.register(async (api) => {
    protectScope(api, db, config.allowedStaffTypes);
    registerStaffRoutes(api);
    registerFamilyRoutes(api, db);
    registerPeopleRoutes(api, db);
    registerChildrenRoutes(api);
  });
}
