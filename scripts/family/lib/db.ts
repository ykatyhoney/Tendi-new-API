// Local-only MariaDB connection for the family scripts and tests (mysql2, no ORM).
// Same guards as scripts/family/_common.sh: local host, a tendi_family_* database, and a server
// whose @@hostname is this machine. The app's own pool comes with Step 0.3.

import { existsSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import mysql from 'mysql2/promise';
import type { Connection, RowDataPacket } from 'mysql2/promise';

export const API_ROOT = join(import.meta.dirname, '..', '..', '..');

/** Loads Tendi-new-API/.env; variables already set in the environment win. */
export function loadEnv(): void {
  const file = join(API_ROOT, '.env');
  if (!existsSync(file)) return;
  for (const [key, val] of Object.entries(parseEnv(readFileSync(file, 'utf8')))) {
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

export function requireEnv(name: string): string {
  const val = process.env[name];
  if (val === undefined || val === '') throw new Error(`${name} is not set (see .env.example)`);
  return val;
}

export async function connectLocal(database: string): Promise<Connection> {
  loadEnv();
  const host = requireEnv('DB_HOST');
  if (!['localhost', '127.0.0.1', '::1'].includes(host.toLowerCase())) {
    throw new Error(`DB_HOST=${host} is not local; refusing to connect`);
  }
  if (!/^tendi_family_[a-z0-9_]+$/.test(database)) {
    throw new Error(`refusing to use database '${database}': the name must match tendi_family_[a-z0-9_]+`);
  }

  const db = await mysql.createConnection({
    host,
    port: Number(requireEnv('DB_PORT')),
    user: requireEnv('DB_USER'),
    password: process.env.DB_PASSWORD ?? '',
    database,
    charset: 'utf8mb4_general_ci',
    dateStrings: true,
  });
  const [[server]] = await db.query<RowDataPacket[]>('SELECT @@hostname AS host');
  if (String(server.host).toLowerCase() !== hostname().toLowerCase()) {
    await db.end();
    throw new Error(`server hostname ${server.host} is not this machine (${hostname()}); refusing to continue`);
  }
  return db;
}
