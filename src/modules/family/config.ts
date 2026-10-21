// Family module configuration: the database account it connects as, and which staff types may use
// the Family API. Host, port and database are the app's (DB_HOST / DB_PORT / DB_NAME).

import Type from 'typebox';
import { readEnvSchema } from '../../config.ts';

/** admin.type values in the tenant schema (enum on the admin table). */
export const ADMIN_TYPES = [
  'developer',
  'superadmin',
  'admin',
  'teacher',
  'bus',
  'manager',
  'office',
  'compliance',
  'kitchen',
  'external',
  'transportation',
  'accounting',
  'billing',
] as const;

const FamilyEnv = Type.Object({
  /** The restricted account from scripts/family/grants.sql. */
  FAMILY_DB_USER: Type.String({ minLength: 1 }),
  FAMILY_DB_PASSWORD: Type.String({ minLength: 1 }),
  FAMILY_DB_POOL_SIZE: Type.Integer({ minimum: 1, default: 10 }),
  /**
   * Comma-separated admin.type values allowed to use the Family API. Default as recorded in
   * docs/CONTEXT.md; decision D5 is still to be confirmed (it may change without code edits).
   */
  // Decision D5 (settled 2026-10-21): admin and office only. Tendi-new mirrors this list in
  // lib/auth/roles.ts (FAMILY_STAFF_TYPES); change both together.
  FAMILY_ALLOWED_STAFF_TYPES: Type.String({ minLength: 1, default: 'admin,office' }),
});

export interface FamilyConfig {
  db: { user: string; password: string; poolSize: number };
  allowedStaffTypes: string[];
}

export function loadFamilyConfig(environment: Record<string, string | undefined> = process.env): FamilyConfig {
  const env = readEnvSchema(FamilyEnv, environment);
  const allowedStaffTypes = env.FAMILY_ALLOWED_STAFF_TYPES.split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  const unknown = allowedStaffTypes.filter((t) => !(ADMIN_TYPES as readonly string[]).includes(t));
  if (allowedStaffTypes.length === 0 || unknown.length > 0) {
    throw new Error(
      `invalid configuration (see .env.example): FAMILY_ALLOWED_STAFF_TYPES has unknown admin types: ${unknown.join(', ') || '(none listed)'}`,
    );
  }
  return {
    db: { user: env.FAMILY_DB_USER, password: env.FAMILY_DB_PASSWORD, poolSize: env.FAMILY_DB_POOL_SIZE },
    allowedStaffTypes,
  };
}
