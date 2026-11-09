import mysql, { type Pool } from 'mysql2/promise'
import type { AppConfig } from '../config/env.js'

/**
 * Run on every new pool connection, before its first query.
 * Strict mode turns a too-long or invalid value into an error instead of a silent truncation, whatever the
 * server's global sql_mode is. NO_ZERO_DATE and NO_ZERO_IN_DATE are left out on purpose: legacy rows hold
 * 0000-00-00, and with them any UPDATE of such a row would fail. A 10-second lock wait turns a stuck save into
 * a 503 RETRY (see db-errors.ts) instead of a 50-second hang.
 */
export const SESSION_SETUP_SQL =
  "SET SESSION sql_mode = 'STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION', " +
  'SESSION innodb_lock_wait_timeout = 10'

/**
 * The family_api pool. The API plugin and the scripts use the same settings.
 * bit(1) values are returned as 0 or 1. Repositories can also select them as `col + 0`.
 */
export function createFamilyPool(db: AppConfig['db']): Pool {
  const pool = mysql.createPool({
    host: db.host,
    port: db.port,
    database: db.name,
    user: db.user,
    password: db.password,
    charset: 'utf8mb4',
    dateStrings: true,
    timezone: 'Z',
    supportBigNumbers: true,
    namedPlaceholders: true,
    connectionLimit: db.poolSize,
    typeCast(field, next) {
      if (field.type === 'BIT' && field.length === 1) {
        const value = field.buffer()
        if (value == null || value.length === 0) {
          return null
        }
        return value[0] ?? 0
      }
      return next()
    },
  })
  // Commands on one connection run in order, so this runs before the query that asked for the connection.
  // A connection that refuses it is destroyed, so no request runs without these settings.
  pool.pool.on('connection', (connection) => {
    connection.query(SESSION_SETUP_SQL, (error) => {
      if (error) {
        connection.destroy()
      }
    })
  })
  return pool
}
