import type { Connection, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import mysql from 'mysql2/promise'
import { afterAll, describe, expect, it } from 'vitest'
import { buildApp } from '../../src/app.js'
import { loadConfig } from '../../src/config/env.js'
import { quoteIdentifier } from '../../src/lib/sql.js'
import { issueDevToken, revokeDevTokens } from '../../scripts/dev-token.js'
import { loadAdminConfig } from '../../scripts/mariadb-admin.js'
import { asFamilyApi } from '../helpers/lock.js'

/**
 * Revision 4 of tendi_family_module.sql: trg_children_family_bu also locks children.family_id, and
 * trg_children_family_bi unlinks a new row that arrives linked. Only family_api with @family_mirror = 1 may
 * link, relink or unlink; @family_unlink = 1 lets any account clear family_id and nothing else.
 * Cases a to g run in a transaction that is rolled back, so they leave no rows behind.
 */

const TEST_DATABASE = 'tendi_family_test'
const adminConfig = loadAdminConfig()
const config = await loadConfig()

const root = await mysql.createConnection({
  host: adminConfig.host,
  port: adminConfig.port,
  user: adminConfig.user,
  password: adminConfig.password,
  database: TEST_DATABASE,
  charset: 'utf8mb4',
  dateStrings: true,
  timezone: 'Z',
})
const familyApi = await mysql.createConnection({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: TEST_DATABASE,
  charset: 'utf8mb4',
  dateStrings: true,
  timezone: 'Z',
})

const linked = await firstRow(
  root,
  `SELECT c.id AS childId, c.family_id AS familyId, c.father_name AS fatherName
   FROM children AS c
   INNER JOIN families AS f ON f.id = c.family_id AND f.status = 'active'
   WHERE c.status <> 'trash'
     AND EXISTS (SELECT 1 FROM family_members AS m WHERE m.family_id = f.id AND m.status = 'active')
   ORDER BY c.id
   LIMIT 1`,
)
const linkedChildId = Number(linked['childId'])
const linkedFamilyId = Number(linked['familyId'])
const linkedFatherName = linked['fatherName'] as string | null
const otherFamilyId = Number(
  (await firstRow(root, `SELECT id FROM families WHERE id <> ? ORDER BY id LIMIT 1`, [linkedFamilyId]))['id'],
)
const unlinkedChildId = Number(
  (await firstRow(root, `SELECT id FROM children WHERE family_id IS NULL AND status <> 'trash' ORDER BY id LIMIT 1`))[
    'id'
  ],
)

afterAll(async () => {
  await root.end()
  await familyApi.end()
})

describe('revision 4 lock on children.family_id', () => {
  it('a) puts back root clearing family_id of a linked child and logs one family_id row', async () => {
    await rolledBack(root, async () => {
      const logId = await lastLogId(root)
      await root.query(`UPDATE children SET family_id = NULL WHERE id = ?`, [linkedChildId])
      expect(await familyIdOf(root, linkedChildId)).toBe(linkedFamilyId)
      expect(await logRowsAfter(root, logId)).toEqual([
        {
          childId: linkedChildId,
          columnName: 'family_id',
          attempted: null,
          kept: String(linkedFamilyId),
          dbUser: expect.stringMatching(/^root@/),
        },
      ])
    })
  })

  it('b) closes the bypass: clear family_id, write father_name, set family_id back', async () => {
    await rolledBack(root, async () => {
      const logId = await lastLogId(root)
      await root.query(`UPDATE children SET family_id = NULL WHERE id = ?`, [linkedChildId])
      await root.query(`UPDATE children SET father_name = 'BYPASSED' WHERE id = ?`, [linkedChildId])
      await root.query(`UPDATE children SET family_id = ? WHERE id = ?`, [linkedFamilyId, linkedChildId])
      const row = await firstRow(root, `SELECT family_id AS familyId, father_name AS fatherName FROM children WHERE id = ?`, [
        linkedChildId,
      ])
      expect(row).toEqual({ familyId: linkedFamilyId, fatherName: linkedFatherName })
      const logs = await logRowsAfter(root, logId)
      expect(logs.map((log) => log.columnName)).toEqual(['family_id', 'father_name'])
      expect(logs[1]).toMatchObject({ attempted: 'BYPASSED', kept: linkedFatherName })
    })
  })

  it('c) puts back root moving the child to another family even with @family_mirror = 1', async () => {
    await rolledBack(root, async () => {
      const logId = await lastLogId(root)
      await withVariable(root, 'family_mirror', async () => {
        await root.query(`UPDATE children SET family_id = ? WHERE id = ?`, [otherFamilyId, linkedChildId])
      })
      expect(await familyIdOf(root, linkedChildId)).toBe(linkedFamilyId)
      expect(await logRowsAfter(root, logId)).toEqual([
        expect.objectContaining({ columnName: 'family_id', attempted: String(otherFamilyId), kept: String(linkedFamilyId) }),
      ])
    })
  })

  it('d) puts back family_api unlinking without @family_mirror', async () => {
    await rolledBack(familyApi, async () => {
      const logId = await lastLogId(familyApi)
      await familyApi.query(`UPDATE children SET family_id = NULL WHERE id = ?`, [linkedChildId])
      expect(await familyIdOf(familyApi, linkedChildId)).toBe(linkedFamilyId)
      expect(await logRowsAfter(familyApi, logId)).toEqual([
        expect.objectContaining({ columnName: 'family_id', attempted: null, dbUser: expect.stringMatching(/^family_api@/) }),
      ])
    })
  })

  it('e) lets root unlink with @family_unlink = 1 unlogged, but not relink', async () => {
    await rolledBack(root, async () => {
      const logId = await lastLogId(root)
      await withVariable(root, 'family_unlink', async () => {
        await root.query(`UPDATE children SET family_id = NULL WHERE id = ?`, [linkedChildId])
        expect(await familyIdOf(root, linkedChildId)).toBeNull()
        expect(await logRowsAfter(root, logId)).toEqual([])

        await root.query(`UPDATE children SET family_id = ? WHERE id = ?`, [linkedFamilyId, linkedChildId])
        expect(await familyIdOf(root, linkedChildId)).toBeNull()
      })
      expect(await logRowsAfter(root, logId)).toEqual([
        expect.objectContaining({ columnName: 'family_id', attempted: String(linkedFamilyId), kept: null }),
      ])
    })
  })

  it('f) lets family_api with @family_mirror = 1 link, move and unlink', async () => {
    await rolledBack(familyApi, async () => {
      const logId = await lastLogId(familyApi)
      await withVariable(familyApi, 'family_mirror', async () => {
        await familyApi.query(`UPDATE children SET family_id = ? WHERE id = ?`, [linkedFamilyId, unlinkedChildId])
        expect(await familyIdOf(familyApi, unlinkedChildId)).toBe(linkedFamilyId)
        await familyApi.query(`UPDATE children SET family_id = ? WHERE id = ?`, [otherFamilyId, unlinkedChildId])
        expect(await familyIdOf(familyApi, unlinkedChildId)).toBe(otherFamilyId)
        await familyApi.query(`UPDATE children SET family_id = NULL WHERE id = ?`, [unlinkedChildId])
        expect(await familyIdOf(familyApi, unlinkedChildId)).toBeNull()
      })
      expect(await logRowsAfter(familyApi, logId)).toEqual([])
    })
  })

  it('g) unlinks a children row that root inserts already linked, and logs it', async () => {
    const [columnRows] = await root.query<RowDataPacket[]>(
      `SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'children' AND COLUMN_NAME NOT IN ('id', 'family_id')
       ORDER BY ORDINAL_POSITION`,
    )
    const columns = columnRows.map((row) => quoteIdentifier(String(row['name']))).join(', ')
    await rolledBack(root, async () => {
      const logId = await lastLogId(root)
      const [inserted] = await root.query<ResultSetHeader>(
        `INSERT INTO children (family_id, ${columns}) SELECT ?, ${columns} FROM children WHERE id = ?`,
        [linkedFamilyId, linkedChildId],
      )
      expect(inserted.affectedRows).toBe(1)
      expect(await familyIdOf(root, inserted.insertId)).toBeNull()
      expect(await logRowsAfter(root, logId)).toEqual([
        expect.objectContaining({ columnName: 'family_id', attempted: String(linkedFamilyId), kept: null }),
      ])
    })
  })
})

describe('revision 4 lock and the API', () => {
  it('h) POST unlink and POST link work and leave the lock log empty', async () => {
    const [adminRows] = await root.query<RowDataPacket[]>(
      `SELECT id FROM admin WHERE status = 'active' AND type = 'admin' ORDER BY id LIMIT 1`,
    )
    const adminId = Number(adminRows[0]?.['id'])
    const token = await issueDevToken(root, adminId)
    const app = await buildApp({ config: { ...config, db: { ...config.db, name: TEST_DATABASE } }, logger: false })
    const headers = { authorization: `Bearer ${token}` }
    const logId = await lastLogId(root)
    try {
      const unlinked = await app.inject({ method: 'POST', url: `/api/v1/children/${linkedChildId}/unlink`, headers })
      expect(unlinked.statusCode).toBe(200)
      expect(await familyIdOf(root, linkedChildId)).toBeNull()

      const relinked = await app.inject({
        method: 'POST',
        url: `/api/v1/families/${linkedFamilyId}/children/${linkedChildId}/link`,
        headers,
      })
      expect(relinked.statusCode).toBe(200)
      expect(await familyIdOf(root, linkedChildId)).toBe(linkedFamilyId)
      expect(await logRowsAfter(root, logId)).toEqual([])
    } finally {
      if ((await familyIdOf(root, linkedChildId)) === null) {
        await asFamilyApi(app.db, async (connection) => {
          await connection.query(`UPDATE children SET family_id = ? WHERE id = ?`, [linkedFamilyId, linkedChildId])
        })
      }
      await revokeDevTokens(root, adminId)
      await app.close()
    }
  })
})

interface LogRow {
  childId: number
  columnName: string
  attempted: string | null
  kept: string | null
  dbUser: string
}

async function rolledBack(connection: Connection, run: () => Promise<void>): Promise<void> {
  await connection.beginTransaction()
  try {
    await run()
  } finally {
    await connection.rollback()
  }
}

/** Sets @family_mirror or @family_unlink to 1 on this connection for the call, and back to NULL after it. */
async function withVariable(
  connection: Connection,
  name: 'family_mirror' | 'family_unlink',
  run: () => Promise<void>,
): Promise<void> {
  await connection.query(`SET @${name} = 1`)
  try {
    await run()
  } finally {
    await connection.query(`SET @${name} = NULL`)
  }
}

async function firstRow(connection: Connection, sql: string, params: unknown[] = []): Promise<RowDataPacket> {
  const [rows] = await connection.query<RowDataPacket[]>(sql, params)
  const row = rows[0]
  if (row === undefined) {
    throw new Error(`tendi_family_test has no row for: ${sql}`)
  }
  return row
}

async function familyIdOf(connection: Connection, childId: number): Promise<number | null> {
  const row = await firstRow(connection, `SELECT family_id AS familyId FROM children WHERE id = ?`, [childId])
  return row['familyId'] === null ? null : Number(row['familyId'])
}

async function lastLogId(connection: Connection): Promise<number> {
  const row = await firstRow(connection, `SELECT COALESCE(MAX(id), 0) AS id FROM family_mirror_lock_log`)
  return Number(row['id'])
}

async function logRowsAfter(connection: Connection, id: number): Promise<LogRow[]> {
  const [rows] = await connection.query<RowDataPacket[]>(
    `SELECT child_id AS childId, col_name AS columnName, attempted_value AS attempted, kept_value AS kept, db_user AS dbUser
     FROM family_mirror_lock_log WHERE id > ? ORDER BY id`,
    [id],
  )
  return rows.map((row) => ({
    childId: Number(row['childId']),
    columnName: String(row['columnName']),
    attempted: row['attempted'] === null ? null : String(row['attempted']),
    kept: row['kept'] === null ? null : String(row['kept']),
    dbUser: String(row['dbUser']),
  }))
}
