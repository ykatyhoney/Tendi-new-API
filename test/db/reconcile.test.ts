import type { RowDataPacket } from 'mysql2/promise'
import mysql from 'mysql2/promise'
import { afterAll, describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/config/env.js'
import { reconcileDatabase } from '../../src/modules/family/services/mirror/reconcile.js'

const TEST_DATABASE = 'tendi_family_test'
const config = await loadConfig()
const pool = mysql.createPool({
  host: config.db.host,
  port: config.db.port,
  database: TEST_DATABASE,
  user: config.db.user,
  password: config.db.password,
  charset: 'utf8mb4',
  dateStrings: true,
  timezone: 'Z',
  supportBigNumbers: true,
  namedPlaceholders: true,
  connectionLimit: 4,
})

afterAll(async () => {
  await pool.end()
})

describe('family reconcile', () => {
  it('reports no differences for the linked children', async () => {
    const report = await reconcileDatabase(pool, { database: TEST_DATABASE })
    expect(report.linkedChildren).toBe(624)
    expect(report.differences).toEqual([])
  })

  it('shows a changed contact phone, and --fix writes that value back', async () => {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT c.id AS childId, c.father_phone AS fatherPhone, p.id AS phoneId, p.phone
       FROM children AS c
       INNER JOIN family_members AS m ON m.family_id = c.family_id AND m.status = 'active'
       INNER JOIN relationship_types AS rt ON rt.code = m.relationship AND rt.parent_slot = 'father' AND rt.slot_rank = 1
       INNER JOIN family_contact_phones AS p
         ON p.family_contact_id = m.family_contact_id AND p.type = 'mobile' AND p.is_primary = 1
       WHERE c.family_id IS NOT NULL
       ORDER BY c.id
       LIMIT 1`,
    )
    const sample = rows[0]
    if (sample === undefined) {
      throw new Error('tendi_family_test has no linked child with a primary father mobile.')
    }
    const childId = Number(sample['childId'])
    const phoneId = Number(sample['phoneId'])
    const phone = String(sample['phone'])
    const fatherPhone = String(sample['fatherPhone'])
    const marker = '9995550141'
    try {
      await pool.query(`UPDATE family_contact_phones SET phone = ? WHERE id = ?`, [marker, phoneId])
      const drifted = await reconcileDatabase(pool, { database: TEST_DATABASE, childId })
      expect(drifted.differences).toEqual([
        expect.objectContaining({ child: childId, column: 'father_phone', stored: fatherPhone, derived: marker }),
      ])

      const fixed = await reconcileDatabase(pool, { database: TEST_DATABASE, childId, fix: true })
      expect(fixed.differences).toEqual([])
      const [mirrored] = await pool.query<RowDataPacket[]>(
        `SELECT father_phone AS fatherPhone FROM children WHERE id = ?`,
        [childId],
      )
      expect(mirrored[0]?.['fatherPhone']).toBe(marker)
    } finally {
      await pool.query(`UPDATE family_contact_phones SET phone = ? WHERE id = ?`, [phone, phoneId])
      await reconcileDatabase(pool, { database: TEST_DATABASE, childId, fix: true })
      const [restored] = await pool.query<RowDataPacket[]>(
        `SELECT father_phone AS fatherPhone FROM children WHERE id = ?`,
        [childId],
      )
      expect(restored[0]?.['fatherPhone']).toBe(fatherPhone)
    }
  })
})