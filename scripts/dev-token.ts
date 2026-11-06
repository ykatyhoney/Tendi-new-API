import { randomBytes } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import mysql, { type ResultSetHeader, type RowDataPacket } from 'mysql2/promise'
import { assertFamilyDatabase } from '../src/lib/database-target.js'
import { tokenHash } from '../src/lib/token-hash.js'
import { loadAdminConfig, loadDatabaseName } from './mariadb-admin.js'

export const DEV_DEVICE_ID = 'tendi-new-dev'
export const DEV_APP_VERSION = 'dev'

export interface DevTokenCommand {
  action: 'issue' | 'revoke'
  adminId: number
}

export function parseDevTokenArgs(argv: readonly string[]): DevTokenCommand {
  const adminFlag = argv.indexOf('--admin')
  const revokeFlag = argv.indexOf('--revoke')
  if (adminFlag !== -1 && revokeFlag !== -1) {
    throw new Error('Use either --admin <id> or --revoke <id>.')
  }
  if (adminFlag === -1 && revokeFlag === -1) {
    throw new Error('Pass --admin <id> to create a token, or --revoke <id> to remove dev tokens.')
  }
  const flag = adminFlag === -1 ? revokeFlag : adminFlag
  const raw = argv[flag + 1]
  if (raw === undefined || !/^[1-9]\d*$/.test(raw)) {
    throw new Error('The admin id must be a positive integer.')
  }
  return { action: adminFlag === -1 ? 'revoke' : 'issue', adminId: Number(raw) }
}

export async function issueDevToken(connection: mysql.Connection, adminId: number): Promise<string> {
  const [rows] = await connection.query<RowDataPacket[]>(
    'SELECT id, status FROM admin WHERE id = ?',
    [adminId],
  )
  const admin = rows[0]
  if (admin === undefined) {
    throw new Error(`No admin row with id ${adminId}.`)
  }
  if (admin['status'] !== 'active') {
    throw new Error(`Admin ${adminId} is ${String(admin['status'])}. Dev tokens are only created for active accounts.`)
  }

  const token = randomBytes(32).toString('hex')
  await connection.query(
    `INSERT INTO admin_api_tokens (admin_id, token_hash, device_id, app_version, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
    [adminId, tokenHash(token), DEV_DEVICE_ID, DEV_APP_VERSION],
  )
  return token
}

export async function revokeDevTokens(connection: mysql.Connection, adminId: number): Promise<number> {
  const [result] = await connection.query<ResultSetHeader>(
    'DELETE FROM admin_api_tokens WHERE admin_id = ? AND device_id = ?',
    [adminId, DEV_DEVICE_ID],
  )
  return result.affectedRows
}

async function main(): Promise<void> {
  const command = parseDevTokenArgs(process.argv.slice(2))
  const config = loadAdminConfig()
  const database = loadDatabaseName()
  assertFamilyDatabase(database)
  const connection = await mysql.createConnection({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database,
    charset: 'utf8mb4',
    dateStrings: true,
    timezone: 'Z',
  })
  try {
    if (command.action === 'revoke') {
      const count = await revokeDevTokens(connection, command.adminId)
      console.log(`Revoked ${count} dev token(s) for admin ${command.adminId}.`)
      return
    }
    const token = await issueDevToken(connection, command.adminId)
    console.error(`Dev token for admin ${command.adminId}. Shown once.`)
    console.log(token)
  } finally {
    await connection.end()
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'Dev token command failed'
    console.error(message)
    process.exitCode = 1
  })
}
