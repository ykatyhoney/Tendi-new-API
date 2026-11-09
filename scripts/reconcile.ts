import { mkdirSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import mysql from 'mysql2/promise'
import { loadConfig } from '../src/config/env.js'
import { assertFamilyDatabase } from '../src/lib/database-target.js'
import {
  formatDifferenceTable,
  reconcileDatabase,
  type ReconcileReport,
} from '../src/modules/family/services/mirror/reconcile.js'

export interface ReconcileCommand {
  childId?: number
  fix: boolean
}

export function parseReconcileArgs(argv: readonly string[]): ReconcileCommand {
  let childId: number | undefined
  let fix = false
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--fix') {
      fix = true
      continue
    }
    if (arg === '--child') {
      const raw = argv[index + 1]
      if (raw === undefined || !/^[1-9]\d*$/.test(raw)) {
        throw new Error('--child needs a positive integer id.')
      }
      childId = Number(raw)
      index += 1
      continue
    }
    throw new Error(`Unknown argument ${arg ?? ''}. Use family:reconcile [--child <id>] [--fix].`)
  }
  if (fix && childId === undefined) {
    throw new Error('--fix needs --child <id>.')
  }
  return childId === undefined ? { fix } : { fix, childId }
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
  const pool = mysql.createPool({
    host: config.db.host,
    port: config.db.port,
    database: config.db.name,
    user: config.db.user,
    password: config.db.password,
    charset: 'utf8mb4',
    dateStrings: true,
    timezone: 'Z',
    supportBigNumbers: true,
    namedPlaceholders: true,
    connectionLimit: config.db.poolSize,
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
  try {
    const report = await reconcileDatabase(pool, {
      database: config.db.name,
      ...(command.childId === undefined ? {} : { childId: command.childId }),
      fix: command.fix,
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
