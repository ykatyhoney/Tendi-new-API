import type { Pool, RowDataPacket } from 'mysql2/promise'
import { rows } from '../../repositories/query.js'
import { withStaffTransaction } from '../../../../lib/with-transaction.js'
import { deriveLegacyValues, legacyColumnValue, sameLegacyValue } from './derive.js'
import { loadChildren, type LoadedChild } from './load.js'
import { writeMirror } from './write.js'
import { ADDITIONAL_MIRROR_COLUMNS, CHILDREN_MIRROR_COLUMNS } from './types.js'

export interface MirrorDifference {
  child: number
  column: string
  stored: string | number | null
  derived: string | number | null
}

export interface ReconcileReport {
  database: string
  childId: number | null
  fixed: boolean
  linkedChildren: number
  differences: MirrorDifference[]
}

const MIRROR_COLUMNS = [...CHILDREN_MIRROR_COLUMNS, ...ADDITIONAL_MIRROR_COLUMNS]

/** Stored parent columns that are not the values the family tables derive. Empty string and NULL match. */
export function mirrorDifferences(loaded: readonly LoadedChild[]): MirrorDifference[] {
  const differences: MirrorDifference[] = []
  for (const row of loaded) {
    const derived = deriveLegacyValues(row.child, row.family)
    for (const column of MIRROR_COLUMNS) {
      const stored = legacyColumnValue(row.stored, column)
      const next = legacyColumnValue(derived, column)
      if (!sameLegacyValue(stored, next)) {
        differences.push({ child: row.child.id, column, stored, derived: next })
      }
    }
  }
  return differences
}

export function formatDifferenceTable(differences: readonly MirrorDifference[]): string {
  const header = ['child', 'column', 'stored', 'derived']
  const body = differences.map((difference) => [
    String(difference.child),
    difference.column,
    JSON.stringify(difference.stored),
    JSON.stringify(difference.derived),
  ])
  const widths = header.map((name, index) => Math.max(name.length, ...body.map((row) => row[index]?.length ?? 0)))
  const line = (cells: readonly string[]) => cells.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join('  ')
  return [line(header), ...body.map((row) => line(row))].join('\n')
}

/**
 * Compares linked children with the derived parent columns. With fix, re-mirrors one child first.
 * The caller owns the pool.
 */
export async function reconcileDatabase(
  pool: Pool,
  options: { database: string; childId?: number; fix?: boolean; auditUser?: number },
): Promise<ReconcileReport> {
  const fix = options.fix === true
  if (fix && options.childId === undefined) {
    throw new Error('--fix needs --child <id>.')
  }
  if (fix && options.auditUser === undefined) {
    throw new Error('--fix needs --admin <id>.')
  }
  if (options.auditUser !== undefined) {
    await requireActiveAdmin(pool, options.auditUser)
  }
  if (options.childId !== undefined) {
    await requireLinkedChild(pool, options.childId)
  }
  if (fix && options.childId !== undefined && options.auditUser !== undefined) {
    const childId = options.childId
    // @audit_user, so the legacy ra_* triggers record the fix under this staff member.
    await withStaffTransaction(pool, options.auditUser, async (connection) => {
      await writeMirror(connection, [childId])
    })
  }
  const loaded = await loadChildren(pool, options.childId === undefined ? 'linked' : [options.childId])
  return {
    database: options.database,
    childId: options.childId ?? null,
    fixed: fix,
    linkedChildren: loaded.length,
    differences: mirrorDifferences(loaded),
  }
}

async function requireLinkedChild(pool: Pool, childId: number): Promise<void> {
  const found = await rows<RowDataPacket>(
    pool,
    `SELECT id, family_id AS familyId FROM children WHERE id = ?`,
    [childId],
  )
  const child = found[0]
  if (child === undefined) {
    throw new Error(`Child ${childId} was not found.`)
  }
  if (child['familyId'] === null) {
    throw new Error(`Child ${childId} is not linked.`)
  }
}

async function requireActiveAdmin(pool: Pool, adminId: number): Promise<void> {
  const found = await rows<RowDataPacket>(pool, `SELECT id, status FROM admin WHERE id = ?`, [adminId])
  if (found[0] === undefined || found[0]['status'] !== 'active') {
    throw new Error(`Admin ${adminId} was not found or is not active.`)
  }
}
