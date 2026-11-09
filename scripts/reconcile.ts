import { mkdirSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { loadConfig } from '../src/config/env.js'
import { assertFamilyDatabase } from '../src/lib/database-target.js'
import { createFamilyPool } from '../src/lib/pool.js'
import {
  formatDifferenceTable,
  reconcileDatabase,
  type ReconcileReport,
} from '../src/modules/family/services/mirror/reconcile.js'

export interface ReconcileCommand {
  childId?: number
  fix: boolean
  /** The staff member a fix is recorded under. Required with --fix. */
  adminId?: number
}

function positiveId(flag: string, raw: string | undefined): number {
  if (raw === undefined || !/^[1-9]\d*$/.test(raw)) {
    throw new Error(`${flag} needs a positive integer id.`)
  }
  return Number(raw)
}

export function parseReconcileArgs(argv: readonly string[]): ReconcileCommand {
  let childId: number | undefined
  let adminId: number | undefined
  let fix = false
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--fix') {
      fix = true
      continue
    }
    if (arg === '--child') {
      childId = positiveId('--child', argv[index + 1])
      index += 1
      continue
    }
    if (arg === '--admin') {
      adminId = positiveId('--admin', argv[index + 1])
      index += 1
      continue
    }
    throw new Error(`Unknown argument ${arg ?? ''}. Use family:reconcile [--child <id>] [--fix --admin <id>].`)
  }
  if (fix && childId === undefined) {
    throw new Error('--fix needs --child <id>.')
  }
  if (fix && adminId === undefined) {
    throw new Error('--fix needs --admin <id>, the staff member the fix is recorded under.')
  }
  return {
    fix,
    ...(childId === undefined ? {} : { childId }),
    ...(adminId === undefined ? {} : { adminId }),
  }
}

export function reconcileReportPath(date = new Date()): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `results/reconcile-${year}-${month}-${day}.json`
}

export function writeReconcileReport(report: ReconcileReport, file = reconcileReportPath()): void {
  mkdirSync('results', { recursive: true })
  writeFileSync(
    file,
    `${JSON.stringify({ ...report, checkedAt: new Date().toISOString() }, null, 2)}\n`,
  )
}

async function main(): Promise<void> {
  const command = parseReconcileArgs(process.argv.slice(2))
  const config = await loadConfig()
  assertFamilyDatabase(config.db.name)
  const pool = createFamilyPool(config.db)
  try {
    const report = await reconcileDatabase(pool, {
      database: config.db.name,
      ...(command.childId === undefined ? {} : { childId: command.childId }),
      fix: command.fix,
      ...(command.adminId === undefined ? {} : { auditUser: command.adminId }),
    })
    const file = reconcileReportPath()
    writeReconcileReport(report, file)
    const scope = report.childId === null ? `${report.linkedChildren} linked children` : `child ${report.childId}`
    console.log(`${scope}, ${report.differences.length} difference${report.differences.length === 1 ? '' : 's'}.`)
    if (report.differences.length > 0) {
      console.log(formatDifferenceTable(report.differences))
    }
    console.error(`Wrote ${file}`)
    process.exitCode = report.differences.length === 0 ? 0 : 1
  } finally {
    await pool.end()
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'Reconcile failed'
    console.error(message)
    process.exitCode = 1
  })
}
