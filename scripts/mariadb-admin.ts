import { spawn } from 'node:child_process'
import { createReadStream, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseEnv } from 'node:util'
import mysql from 'mysql2'
import { assertAllowedDatabase, assertLocalHost } from '../src/lib/database-target.js'
import { familyApiGrantStatements } from '../src/lib/family-api-grants.js'

/** The Windows installer's path on Windows; elsewhere the client on PATH. MARIADB_BIN overrides both. */
const DEFAULT_MARIADB_BIN =
  process.platform === 'win32' ? 'C:\\Program Files\\MariaDB 10.11\\bin\\mariadb.exe' : 'mariadb'

export interface AdminConfig {
  host: string
  port: number
  user: string
  password: string
  familyPassword: string
  clientPath: string
}

export function loadAdminConfig(): AdminConfig {
  const file = readDotEnv('.env')
  const env = { ...file, ...process.env }
  const host = env.DB_HOST || '127.0.0.1'
  const port = Number(env.DB_PORT || '3306')
  const user = env.DB_ADMIN_USER || ''
  const password = env.DB_ADMIN_PASSWORD || ''
  const familyPassword = env.FAMILY_DB_PASSWORD || ''
  const clientPath = env.MARIADB_BIN || DEFAULT_MARIADB_BIN
  assertLocalHost(host)
  if (!user) {
    throw new Error('Set DB_ADMIN_USER in .env. Reset and schema checks use this account, not family_api.')
  }
  if (!familyPassword) {
    throw new Error('Set FAMILY_DB_PASSWORD in .env before creating the family_api account.')
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`DB_PORT must be an integer from 1 to 65535. Got ${env.DB_PORT}.`)
  }
  return { host, port, user, password, familyPassword, clientPath }
}

export function loadDatabaseName(): string {
  const file = readDotEnv('.env')
  const name = process.env['DB_NAME'] || file['DB_NAME'] || ''
  if (!name) {
    throw new Error('Set DB_NAME in .env.')
  }
  return name
}

function readDotEnv(path: string): Record<string, string> {
  try {
    const parsed: Record<string, string> = {}
    for (const [key, value] of Object.entries(parseEnv(readFileSync(path, 'utf8')))) {
      if (typeof value === 'string') {
        parsed[key] = value
      }
    }
    return parsed
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return {}
    }
    throw error
  }
}

export async function runSql(config: AdminConfig, database: string | null, sql: string): Promise<string> {
  if (database !== null) {
    assertAllowedDatabase(database)
  }
  const directory = mkdtempSync(join(tmpdir(), 'tendi-mariadb-'))
  const defaultsFile = join(directory, 'client.cnf')
  writeFileSync(defaultsFile, clientDefaults(config), 'utf8')
  const args = [
    `--defaults-extra-file=${defaultsFile}`,
    '--default-character-set=utf8mb4',
    '--batch',
    '--skip-column-names',
  ]
  if (database !== null) {
    args.push(database)
  }
  args.push('-e', sql)
  try {
    return await spawnMariaDb(config.clientPath, args)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

export async function importDump(config: AdminConfig, database: string, dumpPath: string): Promise<void> {
  assertAllowedDatabase(database)
  const directory = mkdtempSync(join(tmpdir(), 'tendi-mariadb-'))
  const defaultsFile = join(directory, 'client.cnf')
  writeFileSync(defaultsFile, clientDefaults(config), 'utf8')
  const args = [
    `--defaults-extra-file=${defaultsFile}`,
    '--default-character-set=utf8mb4',
    '--max-allowed-packet=64M',
    database,
  ]
  try {
    await spawnMariaDb(config.clientPath, args, dumpPath)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

export async function recreateDatabase(config: AdminConfig, database: string): Promise<void> {
  assertAllowedDatabase(database)
  await runSql(
    config,
    null,
    `DROP DATABASE IF EXISTS \`${database}\`; CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;`,
  )
}

export async function ensureFamilyApi(config: AdminConfig, databases: readonly string[]): Promise<void> {
  for (const database of databases) {
    assertAllowedDatabase(database)
  }
  const password = mysql.escape(config.familyPassword)
  const statements = [
    `DROP USER IF EXISTS 'family_api'@'localhost'`,
    `DROP USER IF EXISTS 'family_api'@'127.0.0.1'`,
    `CREATE USER 'family_api'@'localhost' IDENTIFIED BY ${password}`,
    `CREATE USER 'family_api'@'127.0.0.1' IDENTIFIED BY ${password}`,
    ...databases.flatMap((database) => familyApiGrantStatements(database)),
    'FLUSH PRIVILEGES',
  ]
  await runSql(config, null, statements.join(';\n'))
}

function clientDefaults(config: AdminConfig): string {
  return [
    '[client]',
    `host=${config.host}`,
    `port=${config.port}`,
    `user=${config.user}`,
    `password=${escapeOption(config.password)}`,
    '',
  ].join('\n')
}

function escapeOption(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

function spawnMariaDb(command: string, args: string[], stdinPath?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: [stdinPath === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const { stdin, stdout: out, stderr: err } = child
    if (stdinPath !== undefined) {
      if (stdin === null) {
        reject(new Error('The mariadb client did not accept the dump on stdin.'))
        return
      }
      const input = createReadStream(stdinPath)
      input.on('error', reject)
      input.pipe(stdin)
    }
    if (out === null || err === null) {
      reject(new Error('The mariadb client did not provide output pipes.'))
      return
    }
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    out.on('data', (chunk: Buffer) => stdout.push(chunk))
    err.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.on('error', reject)
    child.on('close', (code) => {
      const output = Buffer.concat(stdout).toString('utf8')
      if (code === 0) {
        resolve(output)
        return
      }
      const errorText = Buffer.concat(stderr).toString('utf8').trim()
      const hint = /Access denied/i.test(errorText)
        ? '\nSet DB_ADMIN_PASSWORD in .env to the local MariaDB admin password.'
        : ''
      reject(new Error((errorText || `mariadb exited with code ${code}`) + hint))
    })
  })
}
