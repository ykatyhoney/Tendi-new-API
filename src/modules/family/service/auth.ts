// Staff authentication for the Family API (PLAN.md "Security, permissions and audit"): no new
// login system. The bearer token's md5 is looked up in admin_api_tokens.token_hash (the same form
// admin.login_auth uses); the admin must be active, and their admin.type must be allowed (D5).

import { createHash } from 'node:crypto';
import type { FamilyDb } from '../db.ts';
import { findStaffByTokenHash, touchToken } from '../repository/staff.ts';

/** The signed-in staff member, attached to every authenticated family request (request.staff). */
export interface Staff {
  adminId: number;
  type: string;
  name: string;
}

/** An error the app's error handler turns into { statusCode, error, message }. */
export class HttpError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

export function bearerToken(authorization: string | undefined): string | null {
  const match = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(authorization ?? '');
  return match ? match[1] : null;
}

export const tokenHash = (token: string) => createHash('md5').update(token, 'utf8').digest('hex');

/** 401 for a missing, unknown or inactive token; 403 for a staff type outside allowedTypes. */
export async function authenticateStaff(
  db: FamilyDb,
  authorization: string | undefined,
  allowedTypes: string[],
): Promise<Staff> {
  const token = bearerToken(authorization);
  if (!token) throw new HttpError(401, 'Missing or malformed Authorization header (expected: Bearer <token>)');

  // TODO(php-team): token expiry and hash format are pending the PHP team's answer (docs/CONTEXT.md,
  // open question 4). Until then the hash is assumed to be the lowercase hex md5 of the raw token
  // (the column comment), and THERE IS NO EXPIRY CHECK: any stored token of an active admin works.
  const row = await findStaffByTokenHash(db.pool, tokenHash(token));
  // Unknown token and inactive account get the same answer, so the response does not reveal which.
  if (!row || row.status !== 'active') throw new HttpError(401, 'Invalid or expired token');

  const type = row.type ?? '';
  if (!allowedTypes.includes(type)) {
    throw new HttpError(403, `Staff type '${type || 'none'}' may not use the Family API`);
  }

  // Only a request the Family API accepts counts as a use of the token; a 403 leaves it untouched.
  await touchToken(db.pool, row.tokenId);
  return { adminId: row.adminId, type, name: `${row.fname} ${row.lname}`.trim() };
}
