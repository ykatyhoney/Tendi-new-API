import type { RowDataPacket } from 'mysql2/promise'
import { likeContains } from '../../../lib/like.js'
import type { RecordStatus } from '../schemas/common.js'
import { normalizedPhoneSql, phoneSearch, phoneSearchParam } from '../../../lib/phone.js'
import { phoneLookup } from './phones.js'
import { placeholders, rows, unionOf, type SearchMatch, type Sql } from './query.js'

export interface FamilyRow extends RowDataPacket {
  id: number
  name: string
  householdPhone: string
  status: RecordStatus
}

export interface MemberRow extends RowDataPacket {
  familyId: number
  memberId: number
  relationship: string
  relationshipLabel: string
  parentSlot: 'father' | 'mother' | null
  slotRank: number | null
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

/**
 * Families whose name, member name, member phone, or household phone matches the query.
 * A member's name is matched as the contact search matches it, "first last" included.
 * One UNION, so paging and the total are done in SQL instead of on a list of ids.
 */
function familyMatch(query: string): SearchMatch | null {
  const q = query.trim()
  if (q.length === 0) {
    return null
  }
  const like = likeContains(q)
  const branches: SearchMatch[] = [
    { sql: `SELECT id FROM families WHERE name LIKE ? ESCAPE '\\\\'`, params: [like] },
    {
      sql: `SELECT m.family_id AS id
            FROM family_members AS m
            INNER JOIN family_contacts AS c ON c.id = m.family_contact_id AND c.status = 'active'
            WHERE m.status = 'active'
              AND (c.fname LIKE ? ESCAPE '\\\\' OR c.lname LIKE ? ESCAPE '\\\\' OR c.legacy_full_name LIKE ? ESCAPE '\\\\'
                   OR CONCAT(c.fname, ' ', c.lname) LIKE ? ESCAPE '\\\\')`,
      params: [like, like, like, like],
    },
  ]
  const phone = phoneSearch(q)
  if (phone !== null) {
    const lookup = phoneLookup(phone)
    branches.push(
      {
        sql: `SELECT m.family_id AS id
              FROM family_members AS m
              INNER JOIN family_contacts AS c ON c.id = m.family_contact_id AND c.status = 'active'
              WHERE m.status = 'active' AND m.family_contact_id IN (${lookup.sql})`,
        params: lookup.params,
      },
      {
        sql: `SELECT f.id AS id
              FROM families AS f
              WHERE ${normalizedPhoneSql('f.household_phone')} ${phone.kind === 'exact' ? '=' : 'LIKE'} ?`,
        params: [phoneSearchParam(phone)],
      },
    )
  }
  return unionOf(branches)
}

export async function pageFamilies(
  db: Sql,
  query: string,
  page: number,
  pageSize: number,
): Promise<{ total: number; families: FamilyRow[] }> {
  const match = familyMatch(query)
  const from =
    match === null
      ? `FROM families AS f WHERE f.status = 'active'`
      : `FROM families AS f INNER JOIN (${match.sql}) AS hit ON hit.id = f.id WHERE f.status = 'active'`
  const params = match?.params ?? []
  const [totals, families] = await Promise.all([
    rows<RowDataPacket>(db, `SELECT COUNT(*) AS total ${from}`, params),
    rows<FamilyRow>(
      db,
      `SELECT f.id, f.name, f.household_phone AS householdPhone, f.status
       ${from}
       ORDER BY f.name, f.id
       LIMIT ? OFFSET ?`,
      [...params, pageSize, (page - 1) * pageSize],
    ),
  ])
  return { total: Number(totals[0]?.['total'] ?? 0), families }
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

export async function findActiveFamily(db: Sql, id: number): Promise<FamilyRow | null> {
  const family = await findFamily(db, id)
  return family?.status === 'active' ? family : null
}

export async function listMembers(db: Sql, familyIds: readonly number[]): Promise<MemberRow[]> {
  if (familyIds.length === 0) {
    return []
  }
  return rows<MemberRow>(
    db,
    `SELECT m.family_id AS familyId, m.id AS memberId, m.relationship, rt.label AS relationshipLabel,
            rt.parent_slot AS parentSlot, rt.slot_rank AS slotRank,
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
