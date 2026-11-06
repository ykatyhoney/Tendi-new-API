import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertAllowedDatabase, assertLocalHost, databaseNameForTarget } from '../../src/lib/database-target.js'
import {
  ADDITIONAL_UPDATE_COLUMNS,
  ADMIN_READ_COLUMNS,
  CHILDREN_UPDATE_COLUMNS,
  FAMILY_TABLES,
  familyApiGrantStatements,
} from '../../src/lib/family-api-grants.js'
import { diffSchema, type SchemaSnapshot } from '../../src/lib/schema-diff.js'
import { isDeadlock } from '../../src/lib/with-transaction.js'

const emptySnapshot = (): SchemaSnapshot => ({
  columns: [],
  indexes: [],
  foreignKeys: [],
  checks: [],
  lockTriggers: [],
})

describe('database targets', () => {
  it('accepts only the local family databases', () => {
    expect(databaseNameForTarget('dev')).toBe('tendi_family_dev')
    expect(databaseNameForTarget('test')).toBe('tendi_family_test')
    expect(() => databaseNameForTarget('prod')).toThrow(/dev or test/)
    expect(() => assertLocalHost('10.0.0.8')).toThrow(/127\.0\.0\.1 and localhost/)
    expect(() => assertAllowedDatabase('tendi_final')).toThrow(/Refusing database/)
    expect(() => assertAllowedDatabase('tendi_family_dev')).not.toThrow()
  })
})

describe('family_api grants', () => {
  const sql = familyApiGrantStatements('tendi_family_dev').join('\n')

  it('grants the seven family tables and withholds relationship deletes and admin.password', () => {
    expect(FAMILY_TABLES).toHaveLength(7)
    expect(CHILDREN_UPDATE_COLUMNS).toHaveLength(11)
    expect(ADDITIONAL_UPDATE_COLUMNS).toHaveLength(18)
    expect(ADMIN_READ_COLUMNS).not.toContain('password')
    expect(sql).toContain('GRANT SELECT, INSERT, UPDATE, DELETE ON `tendi_family_dev`.`families`')
    expect(sql).toContain(
      'GRANT SELECT, INSERT, UPDATE ON `tendi_family_dev`.`relationship_types` TO \'family_api\'@\'localhost\'',
    )
    expect(sql).not.toMatch(/DELETE ON `tendi_family_dev`\.`relationship_types`/)
    expect(sql).not.toMatch(/admin`.*password|password.*admin/i)
    expect(sql).toContain("'family_api'@'127.0.0.1'")
    expect(sql).toContain('GRANT INSERT ON `tendi_family_dev`.`audit_logs`')
    expect(sql).toContain('GRANT SELECT ON `tendi_family_dev`.`family_mirror_lock_log`')
  })
})

describe('schema diff', () => {
  it('reports a column that is missing from the database under test', () => {
    const reference = emptySnapshot()
    reference.columns.push('children\tfamily_id\tint(11)\tYES\t\\N\t\t')
    const differences = diffSchema(emptySnapshot(), reference)
    expect(differences).toEqual(['missing columns: children\tfamily_id\tint(11)\tYES\t\\N\t\t'])
  })
})

describe('deadlock detection', () => {
  it('recognizes MariaDB error 1213', () => {
    expect(isDeadlock({ errno: 1213 })).toBe(true)
    expect(isDeadlock({ errno: 1062 })).toBe(false)
    expect(isDeadlock(new Error('deadlock'))).toBe(false)
  })
})

describe('retired table names', () => {
  it('does not use the names replaced in B1', () => {
    const words = [
      ['peo', 'ple_phones'],
      ['peo', 'ple_emails'],
      ['peo', 'ple_addresses'],
      ['primary_per', 'son_id'],
      ['per', 'son_id'],
      ['peo', 'ple'],
    ].map((parts) => parts.join(''))
    const forbidden = new RegExp(`\\b(${words.join('|')})\\b`)
    const hits: string[] = []
    for (const file of typescriptFiles(['src', 'test', 'scripts'])) {
      const text = readFileSync(file, 'utf8')
      if (forbidden.test(text)) {
        hits.push(file)
      }
    }
    expect(hits).toEqual([])
  })
})

function typescriptFiles(roots: string[]): string[] {
  const files: string[] = []
  for (const root of roots) {
    walk(root, files)
  }
  return files
}

function walk(directory: string, files: string[]): void {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry)
    const info = statSync(path)
    if (info.isDirectory()) {
      walk(path, files)
      continue
    }
    if (path.endsWith('.ts')) {
      files.push(path)
    }
  }
}
