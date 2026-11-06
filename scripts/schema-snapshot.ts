import type { SchemaSnapshot } from '../src/lib/schema-diff.js'
import type { AdminConfig } from './mariadb-admin.js'
import { runSql } from './mariadb-admin.js'

const LOCK_TRIGGERS = ['trg_children_family_bu', 'trg_cai_family_bu'] as const

export async function readSchemaSnapshot(config: AdminConfig, database: string): Promise<SchemaSnapshot> {
  const columns = await query(
    config,
    database,
    `SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA, GENERATION_EXPRESSION
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
     ORDER BY TABLE_NAME, ORDINAL_POSITION`,
  )
  const indexes = await query(
    config,
    database,
    `SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME, COALESCE(SUB_PART, ''), INDEX_TYPE
     FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE()
     ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`,
  )
  const foreignKeys = await query(
    config,
    database,
    `SELECT k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION, k.COLUMN_NAME,
            k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME, r.UPDATE_RULE, r.DELETE_RULE
     FROM information_schema.KEY_COLUMN_USAGE k
     JOIN information_schema.REFERENTIAL_CONSTRAINTS r
       ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
      AND r.TABLE_NAME = k.TABLE_NAME
     WHERE k.TABLE_SCHEMA = DATABASE() AND k.REFERENCED_TABLE_NAME IS NOT NULL
     ORDER BY k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION`,
  )
  const checks = await query(
    config,
    database,
    `SELECT tc.TABLE_NAME, cc.CONSTRAINT_NAME, REPLACE(REPLACE(cc.CHECK_CLAUSE, CHAR(10), ' '), CHAR(13), ' ')
     FROM information_schema.CHECK_CONSTRAINTS cc
     JOIN information_schema.TABLE_CONSTRAINTS tc
       ON tc.CONSTRAINT_SCHEMA = cc.CONSTRAINT_SCHEMA AND tc.CONSTRAINT_NAME = cc.CONSTRAINT_NAME
     WHERE cc.CONSTRAINT_SCHEMA = DATABASE()
     ORDER BY tc.TABLE_NAME, cc.CONSTRAINT_NAME`,
  )
  const lockTriggers = await query(
    config,
    database,
    `SELECT TRIGGER_NAME, ACTION_TIMING, EVENT_MANIPULATION, EVENT_OBJECT_TABLE,
            REPLACE(REPLACE(ACTION_STATEMENT, CHAR(10), ' '), CHAR(13), ' ')
     FROM information_schema.TRIGGERS
     WHERE TRIGGER_SCHEMA = DATABASE()
       AND TRIGGER_NAME IN ('${LOCK_TRIGGERS[0]}', '${LOCK_TRIGGERS[1]}')
     ORDER BY TRIGGER_NAME`,
  )
  return { columns, indexes, foreignKeys, checks, lockTriggers }
}

async function query(config: AdminConfig, database: string, sql: string): Promise<string[]> {
  const output = await runSql(config, database, sql)
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.replace(/\s+/g, ' '))
    .sort()
}
