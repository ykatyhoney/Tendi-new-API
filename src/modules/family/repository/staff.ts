// Staff accounts and their API tokens (existing tables admin and admin_api_tokens).

import type { RowDataPacket } from 'mysql2/promise';
import type { Queryable } from '../db.ts';

export interface StaffTokenRow {
  tokenId: number;
  adminId: number;
  type: string | null;
  status: 'active' | 'inactive' | 'trash';
  fname: string;
  lname: string;
}

/** The token row with this md5 hash and its admin, or null. */
export async function findStaffByTokenHash(db: Queryable, tokenHash: string): Promise<StaffTokenRow | null> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT t.id AS tokenId, a.id AS adminId, a.type, a.status, a.fname, a.lname
       FROM admin_api_tokens t
       JOIN admin a ON a.id = t.admin_id
      WHERE t.token_hash = ?
      ORDER BY t.last_seen_at DESC
      LIMIT 1`,
    [tokenHash],
  );
  return (rows[0] as StaffTokenRow | undefined) ?? null;
}

/** Records that the token was used; at most one write per token per minute. */
export async function touchToken(db: Queryable, tokenId: number): Promise<void> {
  await db.query(
    'UPDATE admin_api_tokens SET last_seen_at = NOW() WHERE id = ? AND last_seen_at < NOW() - INTERVAL 1 MINUTE',
    [tokenId],
  );
}
