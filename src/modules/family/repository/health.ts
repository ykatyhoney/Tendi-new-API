// Repository layer: SQL only, no business rules. Each function takes the Queryable to run on.

import type { Queryable } from '../db.ts';

/** Round trip to the database through the family pool. */
export async function ping(db: Queryable): Promise<void> {
  await db.query('SELECT 1');
}
