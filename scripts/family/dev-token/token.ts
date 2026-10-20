// Dev-only staff tokens for the Family API (npm run family:dev-token). Staff sign-in is not built
// yet (docs/CONTEXT.md, open question 1), so local work on Tendi-new needs a bearer token made by
// hand. A token is an admin_api_tokens row, recognisable by device_id 'tendi-new-dev' and
// app_version 'dev'; only its md5 is stored, the form the API's auth checks.
//
// Only the local development and test databases are allowed, never any other.

import { createHash, randomBytes } from 'node:crypto';
import type { Connection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

export const DEV_DEVICE_ID = 'tendi-new-dev';
export const DEV_APP_VERSION = 'dev';
export const DEV_TOKEN_DATABASES = ['tendi_family_dev', 'tendi_family_test'] as const;

/** Throws unless `database` is one of DEV_TOKEN_DATABASES. */
export function assertDevDatabase(database: string): void {
  if (!(DEV_TOKEN_DATABASES as readonly string[]).includes(database)) {
    throw new Error(
      `refusing to make or revoke dev tokens in '${database}': only ${DEV_TOKEN_DATABASES.join(' or ')}`,
    );
  }
}

export interface DevAdmin {
  id: number;
  type: string | null;
  fname: string;
  lname: string;
}

/**
 * Creates a dev token for an active admin. Returns the raw token (shown once; the row holds its
 * md5) and the admin. Throws for an unknown or inactive admin.
 */
export async function createDevToken(db: Connection, adminId: number): Promise<{ token: string; tokenId: number; admin: DevAdmin }> {
  const [[admin]] = await db.query<RowDataPacket[]>('SELECT id, type, status, fname, lname FROM admin WHERE id = ?', [adminId]);
  if (!admin) throw new Error(`admin ${adminId} does not exist`);
  if (admin.status !== 'active') throw new Error(`admin ${adminId} is ${admin.status}, not active`);

  const token = randomBytes(32).toString('hex');
  const hash = createHash('md5').update(token).digest('hex');
  const [result] = await db.query<ResultSetHeader>(
    `INSERT INTO admin_api_tokens (admin_id, token_hash, device_id, app_version, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, NOW(), NOW())`,
    [adminId, hash, DEV_DEVICE_ID, DEV_APP_VERSION],
  );
  return { token, tokenId: result.insertId, admin: { id: admin.id, type: admin.type, fname: admin.fname, lname: admin.lname } };
}

/** Deletes the admin's dev tokens (device_id 'tendi-new-dev' only); returns how many. */
export async function revokeDevTokens(db: Connection, adminId: number): Promise<number> {
  const [result] = await db.query<ResultSetHeader>(
    'DELETE FROM admin_api_tokens WHERE admin_id = ? AND device_id = ?',
    [adminId, DEV_DEVICE_ID],
  );
  return result.affectedRows;
}
