import type { RowDataPacket } from 'mysql2/promise'
import { likeContains } from '../../../lib/like.js'
import type { AddressType, EmailType, PhoneChannel, PhoneType, RecordStatus } from '../schemas/common.js'
import { phoneSearch } from '../../../lib/phone.js'
import { phoneLookup } from './phones.js'
import { placeholders, rows, unionOf, type SearchMatch, type Sql } from './query.js'

export interface ContactRow extends RowDataPacket {
  id: number
  fname: string
  lname: string
  legacyFullName: string
  hebrewName: string
  occupation: string
  employer: string
  note: string | null
}

export interface PhoneRow extends RowDataPacket {
  id: number
  contactId: number
  phone: string
  type: PhoneType
  typeLabel: string | null
  channel: PhoneChannel
  isPrimary: number
  sortOrder: number
}

export interface EmailRow extends RowDataPacket {
  id: number
  contactId: number
  email: string
  type: EmailType
  typeLabel: string | null
  isPrimary: number
  sortOrder: number
}

export interface AddressRow extends RowDataPacket {
  id: number
  contactId: number
  type: AddressType
  typeLabel: string | null
  line1: string
  line2: string
  city: string
  state: string
  zip: string
  isPrimary: number
}

export interface HouseholdRow extends RowDataPacket {
  contactId: number
  familyId: number
  familyName: string
  familyStatus: RecordStatus
  memberId: number
  relationship: string
  relationshipLabel: string
  isPrimary: number
  sortOrder: number
}

/**
 * Contacts whose name or any phone matches the query, as one UNION. The name is the first name, the last name,
 * "first last" as staff type it, or the legacy name. legacy_full_name is the first name only for nearly every
 * contact, so without the "first last" match a full name found nobody.
 */
function contactMatch(query: string): SearchMatch | null {
  const q = query.trim()
  if (q.length === 0) {
    return null
  }
  const like = likeContains(q)
  const branches: SearchMatch[] = [
    {
      sql: `SELECT id FROM family_contacts
            WHERE fname LIKE ? ESCAPE '\\\\' OR lname LIKE ? ESCAPE '\\\\' OR legacy_full_name LIKE ? ESCAPE '\\\\'
               OR CONCAT(fname, ' ', lname) LIKE ? ESCAPE '\\\\'`,
      params: [like, like, like, like],
    },
  ]
  const phone = phoneSearch(q)
  if (phone !== null) {
    branches.push(phoneLookup(phone))
  }
  return unionOf(branches)
}

export async function pageContacts(
  db: Sql,
  query: string,
  page: number,
  pageSize: number,
  relationships: readonly string[] = [],
): Promise<{ total: number; contacts: ContactRow[] }> {
  const match = contactMatch(query)
  const base =
    match === null
      ? `FROM family_contacts AS c WHERE c.status = 'active'`
      : `FROM family_contacts AS c INNER JOIN (${match.sql}) AS hit ON hit.id = c.id WHERE c.status = 'active'`
  const params = [...(match?.params ?? [])]
  // Only contacts who hold one of these relationships in an active household.
  const from =
    relationships.length === 0
      ? base
      : `${base} AND c.id IN (
           SELECT m.family_contact_id
           FROM family_members AS m
           INNER JOIN families AS f ON f.id = m.family_id AND f.status = 'active'
           WHERE m.status = 'active' AND m.relationship IN (${placeholders(relationships.length)}))`
  params.push(...relationships)
  const [totals, contacts] = await Promise.all([
    rows<RowDataPacket>(db, `SELECT COUNT(*) AS total ${from}`, params),
    rows<ContactRow>(
      db,
      `SELECT c.id, c.fname, c.lname, c.legacy_full_name AS legacyFullName, c.hebrew_name AS hebrewName,
              c.occupation, c.employer, c.note
       ${from}
       ORDER BY c.lname, c.fname, c.id
       LIMIT ? OFFSET ?`,
      [...params, pageSize, (page - 1) * pageSize],
    ),
  ])
  return { total: Number(totals[0]?.['total'] ?? 0), contacts }
}

export async function findActiveContact(db: Sql, id: number): Promise<ContactRow | null> {
  const found = await rows<ContactRow>(
    db,
    `SELECT id, fname, lname, legacy_full_name AS legacyFullName, hebrew_name AS hebrewName,
            occupation, employer, note
     FROM family_contacts
     WHERE id = ? AND status = 'active'`,
    [id],
  )
  return found[0] ?? null
}

export async function listPhones(db: Sql, contactIds: readonly number[]): Promise<PhoneRow[]> {
  if (contactIds.length === 0) {
    return []
  }
  return rows<PhoneRow>(
    db,
    `SELECT id, family_contact_id AS contactId, phone, type, type_label AS typeLabel, channel,
            is_primary AS isPrimary, sort_order AS sortOrder
     FROM family_contact_phones
     WHERE family_contact_id IN (${placeholders(contactIds.length)})
     ORDER BY family_contact_id, is_primary DESC, sort_order, id`,
    contactIds,
  )
}

export async function listEmails(db: Sql, contactIds: readonly number[]): Promise<EmailRow[]> {
  if (contactIds.length === 0) {
    return []
  }
  return rows<EmailRow>(
    db,
    `SELECT id, family_contact_id AS contactId, email, type, type_label AS typeLabel,
            is_primary AS isPrimary, sort_order AS sortOrder
     FROM family_contact_emails
     WHERE family_contact_id IN (${placeholders(contactIds.length)})
     ORDER BY family_contact_id, is_primary DESC, sort_order, id`,
    contactIds,
  )
}

export async function listAddresses(db: Sql, contactIds: readonly number[]): Promise<AddressRow[]> {
  if (contactIds.length === 0) {
    return []
  }
  return rows<AddressRow>(
    db,
    `SELECT id, family_contact_id AS contactId, type, type_label AS typeLabel,
            line1, line2, city, state, zip, is_primary AS isPrimary
     FROM family_contact_addresses
     WHERE family_contact_id IN (${placeholders(contactIds.length)})
     ORDER BY family_contact_id, is_primary DESC, id`,
    contactIds,
  )
}

/** A contact's households. The search summary passes activeOnly; the contact detail shows trashed ones with their status. */
export async function listHouseholds(
  db: Sql,
  contactIds: readonly number[],
  options: { activeOnly?: boolean } = {},
): Promise<HouseholdRow[]> {
  if (contactIds.length === 0) {
    return []
  }
  return rows<HouseholdRow>(
    db,
    `SELECT m.family_contact_id AS contactId, f.id AS familyId, f.name AS familyName, f.status AS familyStatus,
            m.id AS memberId, m.relationship, rt.label AS relationshipLabel,
            m.is_primary AS isPrimary, m.sort_order AS sortOrder
     FROM family_members AS m
     INNER JOIN families AS f ON f.id = m.family_id
     INNER JOIN relationship_types AS rt ON rt.code = m.relationship
     WHERE m.status = 'active' AND m.family_contact_id IN (${placeholders(contactIds.length)})
       ${options.activeOnly === true ? "AND f.status = 'active'" : ''}
     ORDER BY m.family_contact_id, f.name, m.id`,
    contactIds,
  )
}
