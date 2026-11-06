import type { Pool, RowDataPacket } from 'mysql2/promise'
import type { Sql } from './query.js'
import { likeContains } from '../../../lib/like.js'
import { normalizedPhoneSql, phoneSearchKey } from '../../../lib/phone.js'
import { contactIdsForPhone, familyIdsForContacts } from './phones.js'
import { placeholders, rows } from './query.js'

export interface FamilyRow extends RowDataPacket {
  id: number
  name: string
  householdPhone: string
  status: 'active' | 'trash'
}

export interface MemberRow extends RowDataPacket {
  familyId: number
  memberId: number
  relationship: string
  relationshipLabel: string
  isPrimary: number
  sortOrder: number
  contactId: number
  fname: string
  lname: string
  legacyFullName: string
  hebrewName: string
  occupation: string
  employer: string
  note: string | null
}

interface IdRow extends RowDataPacket {
  id: number
}

export async function searchFamilyIds(db: Pool, query: string): Promise<number[] | 'all'> {
  const q = query.trim()
  if (q.length === 0) {
    return 'all'
  }
  const ids = new Set<number>()
  const like = likeContains(q)
  const byFamilyName = await rows<IdRow>(
    db,
    `SELECT id FROM families WHERE status = 'active' AND name LIKE ? ESCAPE '\\\\'`,
    [like],
  )
  for (const row of byFamilyName) {
    ids.add(Number(row.id))
  }
  const byContactName = await rows<IdRow>(
    db,
    `SELECT DISTINCT m.family_id AS id
     FROM family_members AS m
     INNER JOIN families AS f ON f.id = m.family_id AND f.status = 'active'
     INNER JOIN family_contacts AS c ON c.id = m.family_contact_id AND c.status = 'active'
     WHERE m.status = 'active'
       AND (c.fname LIKE ? ESCAPE '\\\\' OR c.lname LIKE ? ESCAPE '\\\\' OR c.legacy_full_name LIKE ? ESCAPE '\\\\')`,
    [like, like, like],
  )
  for (const row of byContactName) {
    ids.add(Number(row.id))
  }
  const phoneKey = phoneSearchKey(q)
  if (phoneKey !== null) {
    const contactIds = await contactIdsForPhone(db, phoneKey)
    for (const familyId of await familyIdsForContacts(db, contactIds)) {
      ids.add(familyId)
    }
    const byHousehold = await rows<IdRow>(
      db,
      `SELECT f.id AS id
       FROM families AS f
       WHERE f.status = 'active'
         AND (
           ${normalizedPhoneSql('f.household_phone')} = ?
           OR (CHAR_LENGTH(?) < 10 AND REGEXP_REPLACE(REGEXP_REPLACE(f.household_phone, '(?i)(ext\\\\.?|x|#).*$', ''), '[^0-9]', '') = ?)
         )`,
      [phoneKey, phoneKey, phoneKey],
    )
    for (const row of byHousehold) {
      ids.add(Number(row.id))
    }
  }
  return [...ids]
}

export async function pageFamilies(
  db: Pool,
  ids: readonly number[] | 'all',
  page: number,
  pageSize: number,
): Promise<{ total: number; families: FamilyRow[] }> {
  const offset = (page - 1) * pageSize
  if (ids === 'all') {
    const totals = await rows<RowDataPacket>(
      db,
      `SELECT COUNT(*) AS total FROM families WHERE status = 'active'`,
    )
    const families = await rows<FamilyRow>(
      db,
      `SELECT id, name, household_phone AS householdPhone, status
       FROM families
       WHERE status = 'active'
       ORDER BY name, id
       LIMIT ? OFFSET ?`,
      [pageSize, offset],
    )
    return { total: Number(totals[0]?.['total'] ?? 0), families }
  }
  if (ids.length === 0) {
    return { total: 0, families: [] }
  }
  const families = await rows<FamilyRow>(
    db,
    `SELECT id, name, household_phone AS householdPhone, status
     FROM families
     WHERE status = 'active' AND id IN (${placeholders(ids.length)})
     ORDER BY name, id
     LIMIT ? OFFSET ?`,
    [...ids, pageSize, offset],
  )
  return { total: ids.length, families }
}

export async function findFamily(db: Sql, id: number): Promise<FamilyRow | null> {
  const found = await rows<FamilyRow>(
    db,
    `SELECT id, name, household_phone AS householdPhone, status
     FROM families
     WHERE id = ?`,
    [id],
  )
  return found[0] ?? null
}

export async function findActiveFamily(db: Pool, id: number): Promise<FamilyRow | null> {
  const family = await findFamily(db, id)
  return family?.status === 'active' ? family : null
}

export async function listMembers(db: Pool, familyIds: readonly number[]): Promise<MemberRow[]> {
  if (familyIds.length === 0) {
    return []
  }
  return rows<MemberRow>(
    db,
    `SELECT m.family_id AS familyId, m.id AS memberId, m.relationship, rt.label AS relationshipLabel,
            m.is_primary AS isPrimary, m.sort_order AS sortOrder,
            c.id AS contactId, c.fname, c.lname, c.legacy_full_name AS legacyFullName,
            c.hebrew_name AS hebrewName, c.occupation, c.employer, c.note
     FROM family_members AS m
     INNER JOIN family_contacts AS c ON c.id = m.family_contact_id AND c.status = 'active'
     INNER JOIN relationship_types AS rt ON rt.code = m.relationship
     WHERE m.status = 'active' AND m.family_id IN (${placeholders(familyIds.length)})
     ORDER BY m.family_id, m.sort_order, m.id`,
    familyIds,
  )
}
