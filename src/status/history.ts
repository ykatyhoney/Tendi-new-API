import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/*
 * Check results over time: a bucket per check per UTC day for 90 days, the last runs of each check, and incidents
 * (a run of failures of one check, from the first failure to the next pass). Kept in one JSON file.
 */

export const DAYS_KEPT = 90
const RECENT_KEPT = 60
const INCIDENTS_KEPT = 50
/** A passing check slower than this counts as degraded. */
export const SLOW_MS = 1000

export interface CheckResult {
  at: string
  ok: boolean
  ms: number
  status: number | null
  error: string | null
}

export interface DayBucket {
  ok: number
  fail: number
  slow: number
  totalMs: number
}

export interface CheckHistory {
  days: Record<string, DayBucket>
  recent: CheckResult[]
}

export interface Incident {
  checkId: string
  name: string
  startedAt: string
  endedAt: string | null
  failures: number
  firstError: string
  lastError: string
}

export interface History {
  version: 1
  checks: Record<string, CheckHistory>
  incidents: Incident[]
  lastRunAt: string | null
}

export function emptyHistory(): History {
  return { version: 1, checks: {}, incidents: [], lastRunAt: null }
}

export function dayOf(iso: string): string {
  return iso.slice(0, 10)
}

/** Adds one result for one check, prunes old days, and opens or closes that check's incident. */
export function record(history: History, checkId: string, name: string, result: CheckResult): void {
  const check = (history.checks[checkId] ??= { days: {}, recent: [] })
  const day = (check.days[dayOf(result.at)] ??= { ok: 0, fail: 0, slow: 0, totalMs: 0 })
  if (result.ok) {
    day.ok += 1
    if (result.ms >= SLOW_MS) {
      day.slow += 1
    }
  } else {
    day.fail += 1
  }
  day.totalMs += result.ms
  check.recent.push(result)
  check.recent.splice(0, Math.max(0, check.recent.length - RECENT_KEPT))
  const oldest = lastDays(result.at, DAYS_KEPT)[0] ?? ''
  for (const key of Object.keys(check.days)) {
    if (key < oldest) {
      delete check.days[key]
    }
  }

  const open = history.incidents.find((incident) => incident.checkId === checkId && incident.endedAt === null)
  if (!result.ok) {
    const error = result.error ?? 'failed'
    if (open === undefined) {
      history.incidents.unshift({ checkId, name, startedAt: result.at, endedAt: null, failures: 1, firstError: error, lastError: error })
      history.incidents.splice(INCIDENTS_KEPT)
    } else {
      open.failures += 1
      open.lastError = error
    }
  } else if (open !== undefined) {
    open.endedAt = result.at
  }
}

/** The last `count` UTC days ending on the day of `isoNow`, oldest first, as YYYY-MM-DD. */
export function lastDays(isoNow: string, count: number): string[] {
  const end = Date.parse(`${dayOf(isoNow)}T00:00:00Z`)
  return Array.from({ length: count }, (_, index) => new Date(end - (count - 1 - index) * 86_400_000).toISOString().slice(0, 10))
}

/** Passed checks over all checks in the kept days, as a percentage, or null without data. */
export function uptime(check: CheckHistory | undefined): number | null {
  if (check === undefined) {
    return null
  }
  let ok = 0
  let total = 0
  for (const day of Object.values(check.days)) {
    ok += day.ok
    total += day.ok + day.fail
  }
  return total === 0 ? null : (ok / total) * 100
}

export function loadHistory(file: string): History {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<History>
    return parsed.version === 1 ? { ...emptyHistory(), ...parsed } : emptyHistory()
  } catch {
    return emptyHistory()
  }
}

/** Written to a temporary file, then renamed, so a crash never leaves half a file. */
export function saveHistory(file: string, history: History): void {
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.tmp`
  writeFileSync(temporary, JSON.stringify(history))
  renameSync(temporary, file)
}
