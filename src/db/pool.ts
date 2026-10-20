// The app's MariaDB connection pool (mysql2/promise, no ORM).

import mysql from 'mysql2/promise';
import type { Pool } from 'mysql2/promise';
import type { Config } from '../config.ts';

export function createPool(db: Config['db']): Pool {
  return mysql.createPool({
    host: db.host,
    port: db.port,
    user: db.user,
    password: db.password,
    database: db.database,
    connectionLimit: db.poolSize,
    waitForConnections: true,
    charset: 'utf8mb4_general_ci',
    dateStrings: true,
  });
}
