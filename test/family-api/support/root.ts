// The database account the Family API suite uses for what family_api may not do: committing the
// staff tokens (support/api.ts) and, in e2e.test.ts, the legacy-style writes and the restore of
// the children's legacy values. It comes from test-only variables, DB_TEST_ROOT_USER and
// DB_TEST_ROOT_PASSWORD (.env.example), never from the app's DB_USER, and connects only to
// tendi_family_test.

import type { Connection } from 'mysql2/promise';
import { connectLocal, loadEnv, requireEnv } from '../../../scripts/family/lib/db.ts';

/** The only database this suite runs against. */
export const TEST_DATABASE = 'tendi_family_test';

/** DB_TEST_NAME, refusing anything but tendi_family_test. */
export function testDatabase(): string {
  loadEnv();
  const database = requireEnv('DB_TEST_NAME');
  if (database !== TEST_DATABASE) {
    throw new Error(
      `refusing to run: DB_TEST_NAME is '${database}'; the Family API suite runs only against ${TEST_DATABASE}`,
    );
  }
  return database;
}

/** A connection to tendi_family_test as DB_TEST_ROOT_USER. */
export async function connectTestRoot(): Promise<Connection> {
  const database = testDatabase();
  return connectLocal(database, {
    user: requireEnv('DB_TEST_ROOT_USER'),
    password: process.env.DB_TEST_ROOT_PASSWORD ?? '',
  });
}
