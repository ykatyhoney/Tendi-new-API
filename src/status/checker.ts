import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { parseEnv } from 'node:util'
import mysql, { type RowDataPacket } from 'mysql2/promise'
import { assertFamilyDatabase } from '../lib/database-target.js'
import { tokenHash } from '../lib/token-hash.js'
import { emptyHistory, lastDays, loadHistory, record, saveHistory, SLOW_MS, uptime, DAYS_KEPT, type History } from './history.js'
import { evaluate, PROBES, type Probe, type ProbeContext } from './probes.js'

/** The checker's own token device id, so `family:dev-token -- --revoke` never removes it. */
export const STATUS_DEVICE_ID = 'tendi-family-status'
export const STATUS_FAMILY_NAME = 'Status check (automated, do not use)'
const STATUS_CONTACT = { fname: 'Statuscheck', lname: 'Automated' }
const REQUEST_TIMEOUT_MS = 15_000

export interface StatusConfig {
  apiUrl: string
  publicUrl: string | null
  intervalSeconds: number
  historyFile: string
  tokenFile: string
  adminId: number | null
  db: { host: string; port: number; name: string; adminUser: string; adminPassword: string }
}

/** From the environment, then .env in the working directory (the API's file). */
export function loadStatusConfig(env: NodeJS.ProcessEnv = process.env): StatusConfig {
  const file = existsSync('.env') ? parseEnv(readFileSync('.env', 'utf8')) : {}
  const value = (name: string, fallback = ''): string => env[name] ?? file[name] ?? fallback
  const name = value('DB_NAME')
  assertFamilyDatabase(name)
  const adminId = Number(value('STATUS_ADMIN_ID'))
  return {
    apiUrl: value('STATUS_API_URL', 'http://127.0.0.1:3100').replace(/\/$/, ''),
    publicUrl: value('STATUS_PUBLIC_URL') === '' ? null : value('STATUS_PUBLIC_URL').replace(/\/$/, ''),
    intervalSeconds: Math.max(15, Number(value('STATUS_INTERVAL_SECONDS', '60')) || 60),
    historyFile: resolve(value('STATUS_HISTORY_FILE', 'results/status-history.json')),
    tokenFile: resolve(value('STATUS_TOKEN_FILE', 'results/status-token')),
    adminId: Number.isInteger(adminId) && adminId > 0 ? adminId : null,
    db: {
      host: value('DB_HOST', '127.0.0.1'),
      port: Number(value('DB_PORT', '3306')),
      name,
      adminUser: value('DB_ADMIN_USER'),
      adminPassword: value('DB_ADMIN_PASSWORD'),
    },
  }
}

interface Reply {
  status: number
  body: unknown
  ms: number
}

export class StatusChecker {
  private history: History
  private token: string | null = null
  private running: Promise<void> | null = null
  private nextRunAt: string | null = null
  private setupError: string | null = null

  constructor(private readonly config: StatusConfig) {
    this.history = loadHistory(config.historyFile)
  }

  get isRunning(): boolean {
    return this.running !== null
  }

  scheduleNext(at: Date): void {
    this.nextRunAt = at.toISOString()
  }

  /** One run of every probe. A run already in progress is joined, not repeated. */
  run(): Promise<void> {
    this.running ??= this.runOnce().finally(() => {
      this.running = null
    })
    return this.running
  }

  private async runOnce(): Promise<void> {
    let context: ProbeContext | null = null
    try {
      context = await this.prepare()
      this.setupError = null
    } catch (error) {
      this.setupError = describeError(error)
    }
    for (const probe of PROBES) {
      const at = new Date().toISOString()
      if (context === null && needsContext(probe)) {
        record(this.history, probe.id, probe.name, { at, ok: false, ms: 0, status: null, error: `setup failed: ${this.setupError}` })
        continue
      }
      const result = await this.probe(probe, context ?? EMPTY_CONTEXT)
      record(this.history, probe.id, probe.name, { at, ...result })
    }
    this.history.lastRunAt = new Date().toISOString()
    saveHistory(this.config.historyFile, this.history)
    const failed = PROBES.filter((probe) => this.history.checks[probe.id]?.recent.at(-1)?.ok === false)
    console.log(`${this.history.lastRunAt} ${PROBES.length - failed.length}/${PROBES.length} checks passed${failed.length > 0 ? `; failing: ${failed.map((probe) => probe.id).join(', ')}` : ''}`)
  }

  private async probe(probe: Probe, context: ProbeContext): Promise<{ ok: boolean; ms: number; status: number | null; error: string | null }> {
    if (probe.publicUrl === true && this.config.publicUrl === null) {
      return { ok: true, ms: 0, status: null, error: null }
    }
    try {
      const body = probe.body?.(context)
      const reply = await this.request(probe.method, probe.path(context), body, probe.auth !== false, probe.publicUrl === true)
      const failure = evaluate(probe, reply, context)
      return { ok: failure === null, ms: reply.ms, status: reply.status, error: failure }
    } catch (error) {
      return { ok: false, ms: 0, status: null, error: describeError(error) }
    }
  }

  private async request(method: string, path: string, body: unknown, auth: boolean, publicUrl = false): Promise<Reply> {
    const headers: Record<string, string> = {}
    if (auth) {
      headers['authorization'] = `Bearer ${await this.currentToken()}`
    }
    if (body !== undefined) {
      headers['content-type'] = 'application/json'
    }
    const started = performance.now()
    const response = await fetch(`${publicUrl ? this.config.publicUrl : this.config.apiUrl}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    const text = await response.text()
    const ms = Math.round(performance.now() - started)
    let parsed: unknown = text
    try {
      parsed = JSON.parse(text)
    } catch {
      // Not JSON (an nginx page, for example). The status is what counts.
    }
    return { status: response.status, body: parsed, ms }
  }

  /** A GET that must succeed; used while preparing the context. */
  private async must(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
    let reply = await this.request(method, path, body, true)
    if (reply.status === 401) {
      // The token was revoked, or db:dev:reset removed it. Issue a new one and try once more.
      this.token = await this.issueToken()
      reply = await this.request(method, path, body, true)
    }
    if (reply.status !== 200) {
      throw new Error(`${method} ${path} answered ${reply.status} ${JSON.stringify(reply.body).slice(0, 200)}`)
    }
    return reply.body as Record<string, unknown>
  }

  /** Finds or creates the status household and contact, and reads the values the probes resend. */
  private async prepare(): Promise<ProbeContext> {
    const search = await this.must('GET', `/api/v1/families?q=${encodeURIComponent(STATUS_FAMILY_NAME)}&pageSize=100`)
    const found = (search['items'] as { id: number; name: string }[]).find((item) => item.name === STATUS_FAMILY_NAME)
    const familyId = found?.id ?? Number(((await this.must('POST', '/api/v1/families', { name: STATUS_FAMILY_NAME }))['family'] as { id: number }).id)
    let family = await this.must('GET', `/api/v1/families/${familyId}`)
    if ((family['members'] as unknown[]).length === 0) {
      family = (await this.must('POST', `/api/v1/families/${familyId}/members`, { relationship: 'guardian', contact: STATUS_CONTACT }))['family'] as Record<string, unknown>
    }
    const member = (family['members'] as { id: number; sortOrder: number; contact: { id: number } }[])[0]
    if (member === undefined) {
      throw new Error('the status household has no member')
    }
    const contactId = member.contact.id
    let contact = await this.must('GET', `/api/v1/contacts/${contactId}`)
    if ((contact['phones'] as unknown[]).length === 0) {
      await this.must('PUT', `/api/v1/contacts/${contactId}/phones`, { phones: [{ phone: '(000) 000-0000', type: 'home', isPrimary: true }] })
    }
    if ((contact['emails'] as unknown[]).length === 0) {
      await this.must('PUT', `/api/v1/contacts/${contactId}/emails`, { emails: [{ email: 'status-check@example.invalid', isPrimary: true }] })
    }
    if ((contact['addresses'] as unknown[]).length === 0) {
      await this.must('PUT', `/api/v1/contacts/${contactId}/addresses`, { addresses: [{ type: 'home', line1: 'Status check', isPrimary: true }] })
    }
    contact = await this.must('GET', `/api/v1/contacts/${contactId}`)

    const page = await this.must('GET', '/api/v1/families?pageSize=25')
    const linked = (page['items'] as { id: number; children: { id: number }[] }[]).find(
      (item) => item.id !== familyId && item.children.length > 0,
    )
    const linkedChildId = linked?.children[0]?.id
    if (linkedChildId === undefined) {
      throw new Error('no linked child found for the link checks')
    }
    const types = await this.must('GET', '/api/v1/relationship-types')
    const father = (types['items'] as { code: string; sortOrder: number }[]).find((type) => type.code === 'father')

    return {
      familyId,
      familyName: String(family['name']),
      householdPhone: String(family['householdPhone']),
      memberId: member.id,
      memberSortOrder: member.sortOrder,
      contactId,
      contactNote: (contact['note'] as string | null) ?? null,
      phones: (contact['phones'] as Record<string, unknown>[]).map((row) => pick(row, ['id', 'phone', 'type', 'typeLabel', 'channel', 'isPrimary', 'sortOrder'])),
      emails: (contact['emails'] as Record<string, unknown>[]).map((row) => pick(row, ['id', 'email', 'type', 'typeLabel', 'isPrimary', 'sortOrder'])),
      addresses: (contact['addresses'] as Record<string, unknown>[]).map((row) => pick(row, ['id', 'type', 'typeLabel', 'line1', 'line2', 'city', 'state', 'zip', 'isPrimary'])),
      linkedChildId,
      fatherSortOrder: father?.sortOrder ?? 1,
    }
  }

  private async currentToken(): Promise<string> {
    if (this.token === null) {
      this.token = existsSync(this.config.tokenFile) ? readFileSync(this.config.tokenFile, 'utf8').trim() : await this.issueToken()
    }
    return this.token
  }

  /** A staff token for the checker, stored hashed like every token (dev databases only). */
  private async issueToken(): Promise<string> {
    const { db } = this.config
    const connection = await mysql.createConnection({ host: db.host, port: db.port, user: db.adminUser, password: db.adminPassword, database: db.name })
    try {
      const [admins] = await connection.query<RowDataPacket[]>(
        `SELECT id FROM admin WHERE status = 'active' AND ${this.config.adminId === null ? `LOWER(TRIM(type)) = 'admin'` : 'id = ?'} ORDER BY id LIMIT 1`,
        this.config.adminId === null ? [] : [this.config.adminId],
      )
      const adminId = admins[0]?.['id']
      if (adminId === undefined) {
        throw new Error('no active admin for the status checker (set STATUS_ADMIN_ID)')
      }
      const token = randomBytes(32).toString('hex')
      await connection.query(`DELETE FROM admin_api_tokens WHERE admin_id = ? AND device_id = ?`, [adminId, STATUS_DEVICE_ID])
      await connection.query(
        `INSERT INTO admin_api_tokens (admin_id, token_hash, device_id, app_version, created_at, last_seen_at)
         VALUES (?, ?, ?, 'status-checker', UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
        [adminId, tokenHash(token), STATUS_DEVICE_ID],
      )
      mkdirSync(dirname(this.config.tokenFile), { recursive: true })
      writeFileSync(this.config.tokenFile, token, { mode: 0o600 })
      chmodSync(this.config.tokenFile, 0o600)
      return token
    } finally {
      await connection.end()
    }
  }

  /** What the page shows. */
  summary(now = new Date()): StatusSummary {
    const days = lastDays(now.toISOString(), DAYS_KEPT)
    const groups: StatusSummary['groups'] = []
    for (const probe of PROBES) {
      const check = this.history.checks[probe.id]
      const last = check?.recent.at(-1) ?? null
      const state: CheckState = last === null ? 'unknown' : !last.ok ? 'down' : last.ms >= SLOW_MS ? 'degraded' : 'operational'
      let group = groups.find((entry) => entry.name === probe.group)
      if (group === undefined) {
        group = { name: probe.group, checks: [] }
        groups.push(group)
      }
      group.checks.push({
        id: probe.id,
        name: probe.name,
        method: probe.method,
        route: probe.route,
        kind: probe.kind,
        note: probe.note,
        target: probe.publicUrl === true ? (this.config.publicUrl ?? 'not configured') : 'API',
        state,
        last,
        uptime: uptime(check),
        days: days.map((date) => {
          const bucket = check?.days[date]
          const total = bucket === undefined ? 0 : bucket.ok + bucket.fail
          return {
            date,
            total,
            fail: bucket?.fail ?? 0,
            slow: bucket?.slow ?? 0,
            uptime: total === 0 || bucket === undefined ? null : (bucket.ok / total) * 100,
            avgMs: total === 0 || bucket === undefined ? null : Math.round(bucket.totalMs / total),
          }
        }),
      })
    }
    const states = groups.flatMap((group) => group.checks.map((check) => check.state))
    const down = states.filter((state) => state === 'down').length
    // The API process not answering at all is a major outage, even though nginx still answers the public check.
    const apiDown = groups.some((group) => group.checks.some((check) => check.id === 'health-live' && check.state === 'down'))
    const overall: StatusSummary['overall'] =
      states.every((state) => state === 'unknown')
        ? 'unknown'
        : down === states.length || apiDown
          ? 'major'
          : down > 0
            ? 'partial'
            : states.includes('degraded')
              ? 'degraded'
              : 'operational'
    return {
      generatedAt: now.toISOString(),
      lastRunAt: this.history.lastRunAt,
      nextRunAt: this.nextRunAt,
      running: this.isRunning,
      intervalSeconds: this.config.intervalSeconds,
      slowMs: SLOW_MS,
      overall,
      setupError: this.setupError,
      groups,
      incidents: this.history.incidents.slice(0, 20),
    }
  }

  /** For tests. */
  resetHistory(): void {
    this.history = emptyHistory()
  }
}

export type CheckState = 'operational' | 'degraded' | 'down' | 'unknown'

export interface StatusSummary {
  generatedAt: string
  lastRunAt: string | null
  nextRunAt: string | null
  running: boolean
  intervalSeconds: number
  slowMs: number
  overall: 'operational' | 'degraded' | 'partial' | 'major' | 'unknown'
  setupError: string | null
  groups: {
    name: string
    checks: {
      id: string
      name: string
      method: string
      route: string
      kind: string
      note: string
      target: string
      state: CheckState
      last: { at: string; ok: boolean; ms: number; status: number | null; error: string | null } | null
      uptime: number | null
      days: { date: string; total: number; fail: number; slow: number; uptime: number | null; avgMs: number | null }[]
    }[]
  }[]
  incidents: History['incidents']
}

const EMPTY_CONTEXT: ProbeContext = {
  familyId: 0, familyName: '', householdPhone: '', memberId: 0, memberSortOrder: 0, contactId: 0, contactNote: null,
  phones: [], emails: [], addresses: [], linkedChildId: 0, fatherSortOrder: 0,
}

/** Probes that only call fixed paths (health, access, validation) still run when the setup failed. */
function needsContext(probe: Probe): boolean {
  return !['health-live', 'health-ready', 'access-token', 'access-public', 'families-create', 'links-unlink', 'types-list', 'types-create'].includes(probe.id)
}

/** fetch() reports "fetch failed"; the cause says why (ECONNREFUSED, a timeout, a TLS error). */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error)
  }
  const cause = error.cause as { code?: unknown; message?: unknown } | undefined
  if (error.name === 'TimeoutError') {
    return 'no answer within 15 s'
  }
  if (cause !== undefined && cause !== null) {
    const code = typeof cause.code === 'string' ? cause.code : undefined
    const message = typeof cause.message === 'string' ? cause.message : undefined
    return `${error.message}: ${code ?? message ?? 'unknown cause'}${code === 'ECONNREFUSED' ? ' (the API is not running)' : ''}`
  }
  return error.message
}

function pick(row: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const picked: Record<string, unknown> = {}
  for (const key of keys) {
    if (row[key] !== undefined) {
      picked[key] = row[key]
    }
  }
  return picked
}
