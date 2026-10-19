// Service layer: business rules and transactions; calls the repository, never builds SQL itself.

import type { FastifyBaseLogger } from 'fastify';
import type { FamilyDb } from '../db.ts';
import { ping } from '../repository/health.ts';

export async function checkFamilyDb(db: FamilyDb, log: FastifyBaseLogger): Promise<'ok' | 'down'> {
  try {
    await ping(db.pool);
    return 'ok';
  } catch (err) {
    log.warn({ err }, 'family health: database unreachable through the family pool');
    return 'down';
  }
}
