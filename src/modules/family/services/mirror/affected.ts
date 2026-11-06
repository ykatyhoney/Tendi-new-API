import type { RowDataPacket } from 'mysql2/promise'
import { rows, type Sql } from '../../repositories/query.js'

/** Linked children of one family. A family, member, or rights change re-mirrors these. */
export async function affectedChildIdsForFamily(db: Sql, familyId: number): Promise<number[]> {
  const found = await rows<RowDataPacket>(
    db,
    `SELECT id FROM children WHERE family_id = ? ORDER BY id`,
    [familyId],
  )
  return found.map((row) => Number(row['id']))
}

/** Linked children of every family this contact belongs to. */
export async function affectedChildIdsForContact(db: Sql, contactId: number): Promise<number[]> {
  const found = await rows<RowDataPacket>(
    db,
    `SELECT DISTINCT c.id AS id
     FROM family_members AS m
     INNER JOIN children AS c ON c.family_id = m.family_id
     WHERE m.family_contact_id = ? AND m.status = 'active'
     ORDER BY c.id`,
    [contactId],
  )
  return found.map((row) => Number(row['id']))
}
