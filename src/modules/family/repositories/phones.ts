import type { Pool, RowDataPacket } from 'mysql2/promise'
import { placeholders, rows } from './query.js'

interface IdRow extends RowDataPacket {
  familyContactId: number
}

/**
 * Equality on the generated column. EXPLAIN must use idx_fcp_norm.
 * Do not wrap phone_normalized in a function.
 */
export const PHONE_LOOKUP_SQL =
  'SELECT p.family_contact_id AS familyContactId FROM family_contact_phones AS p WHERE p.phone_normalized = ?'

export async function contactIdsForPhone(db: Pool, phoneKey: string): Promise<number[]> {
  const found = await rows<IdRow>(db, PHONE_LOOKUP_SQL, [phoneKey])
  return [...new Set(found.map((row) => Number(row.familyContactId)))]
}

export async function familyIdsForContacts(db: Pool, contactIds: readonly number[]): Promise<number[]> {
  if (contactIds.length === 0) {
    return []
  }
  const found = await rows<RowDataPacket>(
    db,
    `SELECT DISTINCT m.family_id AS familyId
     FROM family_members AS m
     INNER JOIN families AS f ON f.id = m.family_id AND f.status = 'active'
     INNER JOIN family_contacts AS c ON c.id = m.family_contact_id AND c.status = 'active'
     WHERE m.status = 'active' AND m.family_contact_id IN (${placeholders(contactIds.length)})`,
    contactIds,
  )
  return found.map((row) => Number(row['familyId']))
}
