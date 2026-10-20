// Family module (PLAN.md "Family API"): its own config, pool (family_api), service layer and
// repository layer. Routes live in routes/ and register here; the Family API routes
// (/families, /people/:id, /children/:childId/unlink, ...) are added in the following steps.
//
// Layers: routes/ (HTTP: schemas, status codes) -> service/ (rules, familyDb.transaction for every
// write) -> repository/ (SQL only, on a Queryable). Nothing here caches family data (MVP).

import type { FastifyInstance } from 'fastify';
import { loadFamilyConfig } from './config.ts';
import { createFamilyDb } from './db.ts';
import { registerHealthRoutes } from './routes/health.ts';

export default async function familyModule(app: FastifyInstance): Promise<void> {
  const db = createFamilyDb(app.config.db, loadFamilyConfig());
  app.addHook('onClose', async () => {
    await db.pool.end();
  });

  registerHealthRoutes(app, db);
}
