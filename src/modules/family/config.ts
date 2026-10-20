// Family module configuration: the database account it connects as. Host, port and database are
// the app's (DB_HOST / DB_PORT / DB_NAME); only the account differs.

import Type from 'typebox';
import { readEnvSchema } from '../../config.ts';

const FamilyEnv = Type.Object({
  /** The restricted account from scripts/family/grants.sql. */
  FAMILY_DB_USER: Type.String({ minLength: 1 }),
  FAMILY_DB_PASSWORD: Type.String({ minLength: 1 }),
  FAMILY_DB_POOL_SIZE: Type.Integer({ minimum: 1, default: 10 }),
});

export interface FamilyConfig {
  db: { user: string; password: string; poolSize: number };
}

export function loadFamilyConfig(environment: Record<string, string | undefined> = process.env): FamilyConfig {
  const env = readEnvSchema(FamilyEnv, environment);
  return { db: { user: env.FAMILY_DB_USER, password: env.FAMILY_DB_PASSWORD, poolSize: env.FAMILY_DB_POOL_SIZE } };
}
