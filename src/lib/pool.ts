import mysql, { type Pool } from 'mysql2/promise'
import type { AppConfig } from '../config/env.js'

/**
 * The family_api pool. The API plugin and the scripts use the same settings.
 * bit(1) values are returned as 0 or 1. Repositories can also select them as `col + 0`.
 */
export function createFamilyPool(db: AppConfig['db']): Pool {
  return mysql.createPool({
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
}
