import mysql, { type PoolConnection, type RowDataPacket } from 'mysql2/promise'
import { afterAll, describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/config/env.js'
import { deriveLegacyValues, legacyColumnValue, sameLegacyValue } from '../../src/modules/family/services/mirror/derive.js'
import { loadChildren } from '../../src/modules/family/services/mirror/load.js'
import { writeMirror } from '../../src/modules/family/services/mirror/write.js'
import { affectedChildIdsForContact, affectedChildIdsForFamily } from '../../src/modules/family/services/mirror/affected.js'
import {
  ADDITIONAL_MIRROR_COLUMNS,
  CHILDREN_MIRROR_COLUMNS,
} from '../../src/modules/family/services/mirror/types.js'

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

describe('mirror parity', () => {
  it('matches the stored columns for every linked child', async () => {
    const loaded = await loadChildren(pool, 'linked')
    expect(loaded).toHaveLength(624)
    const differences: string[] = []
    for (const row of loaded) {
      const derived = deriveLegacyValues(row.child, row.family)
      for (const column of [...CHILDREN_MIRROR_COLUMNS, ...ADDITIONAL_MIRROR_COLUMNS]) {
        const stored = legacyColumnValue(row.stored, column)
        const next = legacyColumnValue(derived, column)
        if (!sameLegacyValue(stored, next)) {
          differences.push(
            `${row.child.id}\t${column}\tstored=${JSON.stringify(stored)}\tderived=${JSON.stringify(next)}`,
          )
        }
      }
    }
    expect(differences, differences.slice(0, 20).join('\n')).toEqual([])
  })
})

describe('mirror writer', () => {
  it('writes nothing when the stored columns already match', async () => {
    const sample = await oneChild()
    const connection = await pool.getConnection()
    try {
      await connection.beginTransaction()
      const changed = await writeMirror(connection, [sample.childId])
      expect(changed).toEqual([])
    } finally {
      await connection.rollback()
      connection.release()
    }
  })

  it('updates only the changed phone and rolls the write back', async () => {
    const sample = await oneChild()
    const connection = await pool.getConnection()
    try {
      await connection.beginTransaction()
      await connection.query(`UPDATE family_contact_phones SET phone = ? WHERE id = ?`, ['9995550199', sample.phoneId])
      const changed = await writeMirror(connection, [sample.childId])
      expect(changed).toEqual([sample.childId])
      const [rows] = await connection.query<RowDataPacket[]>(
        `SELECT father_phone AS phone FROM children WHERE id = ?`,
        [sample.childId],
      )
      expect(rows[0]?.['phone']).toBe('9995550199')
    } finally {
      await connection.rollback()
      connection.release()
    }
    const [after] = await pool.query<RowDataPacket[]>(`SELECT phone FROM family_contact_phones WHERE id = ?`, [
      sample.phoneId,
    ])
    expect(after[0]?.['phone']).toBe(sample.phone)
  })

  it('refuses a home phone that does not fit the old column', async () => {
    const sample = await oneChild()
    const connection = await pool.getConnection()
    try {
      await connection.beginTransaction()
      await replaceHomePhone(connection, sample.contactId, '1'.repeat(31))
      await expect(writeMirror(connection, [sample.childId])).rejects.toMatchObject({
        statusCode: 409,
        code: 'VALUE_TOO_LONG',
        details: { column: 'father_home_phone' },
      })
    } finally {
      await connection.rollback()
      connection.release()
    }
  })

  it('finds the linked children of a family and of a contact', async () => {
    const sample = await oneChild()
    const forFamily = await affectedChildIdsForFamily(pool, sample.familyId)
    expect(forFamily).toContain(sample.childId)
    const forContact = await affectedChildIdsForContact(pool, sample.contactId)
    expect(forContact).toContain(sample.childId)
  })
})

interface SampleChild {
  childId: number
  familyId: number
  contactId: number
  fname: string
  phoneId: number
  phone: string
}

async function oneChild(): Promise<SampleChild> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT c.id AS childId, c.family_id AS familyId, m.family_contact_id AS contactId, ct.fname,
            p.id AS phoneId, p.phone
     FROM children AS c
     INNER JOIN family_members AS m ON m.family_id = c.family_id AND m.status = 'active'
     INNER JOIN relationship_types AS rt ON rt.code = m.relationship AND rt.parent_slot = 'father' AND rt.slot_rank = 1
     INNER JOIN family_contacts AS ct ON ct.id = m.family_contact_id
     INNER JOIN family_contact_phones AS p
       ON p.family_contact_id = ct.id AND p.type = 'mobile' AND p.is_primary = 1
     WHERE c.family_id IS NOT NULL
     ORDER BY c.id
     LIMIT 1`,
  )
  const row = rows[0]
  if (row === undefined) {
    throw new Error('tendi_family_test has no linked child with a primary father mobile.')
  }
  return {
    childId: Number(row['childId']),
    familyId: Number(row['familyId']),
    contactId: Number(row['contactId']),
    fname: String(row['fname']),
    phoneId: Number(row['phoneId']),
    phone: String(row['phone']),
  }
}

async function replaceHomePhone(connection: PoolConnection, contactId: number, phone: string): Promise<void> {
  const [homes] = await connection.query<RowDataPacket[]>(
    `SELECT id FROM family_contact_phones
     WHERE family_contact_id = ? AND type = 'home'
     ORDER BY is_primary DESC, sort_order, id
     LIMIT 1`,
    [contactId],
  )
  const homeId = homes[0]?.['id']
  if (homeId === undefined) {
    await connection.query(
      `INSERT INTO family_contact_phones (family_contact_id, phone, type, is_primary, sort_order)
       VALUES (?, ?, 'home', 0, 0)`,
      [contactId, phone],
    )
    return
  }
  await connection.query(`UPDATE family_contact_phones SET phone = ? WHERE id = ?`, [phone, homeId])
}
