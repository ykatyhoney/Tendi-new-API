import type { RowDataPacket } from 'mysql2/promise'
import { placeholders, rows, type Sql } from '../../repositories/query.js'
import type { LegacyValues, MirrorFamily, MirrorMember, NotifyMethod, ParentSlot } from './types.js'
import { ADDITIONAL_MIRROR_COLUMNS, CHILDREN_MIRROR_COLUMNS } from './types.js'

export interface LoadedChild {
  child: { id: number }
  family: MirrorFamily
  stored: LegacyValues
  hasAdditional: boolean
}

interface ChildRow extends RowDataPacket {
  id: number
  familyId: number
  householdPhone: string
  additionalId: number | null
}

interface MemberRow extends RowDataPacket {
  familyId: number
  id: number
  contactId: number
  status: 'active' | 'trash'
  slot: ParentSlot | null
  slotRank: number | null
  sortOrder: number
  isPrimary: number
  fname: string
  lname: string
  legacyFullName: string
  occupation: string
  employer: string
}

interface PhoneRow extends RowDataPacket {
  id: number
  contactId: number
  phone: string
  type: MirrorMember['contact']['phones'][number]['type']
  typeLabel: string | null
  isPrimary: number
  sortOrder: number
}

interface EmailRow extends RowDataPacket {
  id: number
  contactId: number
  email: string
  isPrimary: number
  sortOrder: number
}

interface AddressRow extends RowDataPacket {
  id: number
  contactId: number
  type: MirrorMember['contact']['addresses'][number]['type']
  line1: string
  line2: string
  city: string
  state: string
  zip: string
  isPrimary: number
}

interface RightsRow extends RowDataPacket {
  memberId: number
  childId: number
  receivesNotifications: number
  notifyMethod: NotifyMethod
  isPaymentResponsible: number
}

export async function loadChildren(db: Sql, childIds: readonly number[] | 'linked'): Promise<LoadedChild[]> {
  const filter = childIds === 'linked' ? 'c.family_id IS NOT NULL' : `c.id IN (${placeholders(childIds.length)})`
  const params = childIds === 'linked' ? [] : childIds
  if (childIds !== 'linked' && childIds.length === 0) {
    return []
  }
  const childRows = await rows<ChildRow>(
    db,
    `SELECT c.id, c.family_id AS familyId, f.household_phone AS householdPhone, cai.id AS additionalId,
            ${CHILDREN_MIRROR_COLUMNS.map((column) => mirrorSelect(column)).join(', ')},
            ${ADDITIONAL_MIRROR_COLUMNS.map((column) => `cai.\`${column}\` AS \`${column}\``).join(', ')}
     FROM children AS c
     INNER JOIN families AS f ON f.id = c.family_id
     LEFT JOIN children_additional_information AS cai ON cai.child_id = c.id
     WHERE ${filter}`,
    params,
  )
  if (childRows.length === 0) {
    return []
  }
  const familyIds = [...new Set(childRows.map((row) => Number(row.familyId)))]
  const ids = childRows.map((row) => Number(row.id))
  const [memberRows, rightsRows] = await Promise.all([
    rows<MemberRow>(
      db,
      `SELECT m.family_id AS familyId, m.id, m.family_contact_id AS contactId, m.status,
              rt.parent_slot AS slot, rt.slot_rank AS slotRank, m.sort_order AS sortOrder, m.is_primary AS isPrimary,
              c.fname, c.lname, c.legacy_full_name AS legacyFullName, c.occupation, c.employer
       FROM family_members AS m
       INNER JOIN family_contacts AS c ON c.id = m.family_contact_id AND c.status = 'active'
       INNER JOIN relationship_types AS rt ON rt.code = m.relationship
       WHERE m.family_id IN (${placeholders(familyIds.length)})`,
      familyIds,
    ),
    rows<RightsRow>(
      db,
      `SELECT member_id AS memberId, child_id AS childId,
              receives_notifications AS receivesNotifications, notify_method AS notifyMethod,
              is_payment_responsible AS isPaymentResponsible
       FROM family_member_children
       WHERE child_id IN (${placeholders(ids.length)})`,
      ids,
    ),
  ])
  const contactIds = [...new Set(memberRows.map((row) => Number(row.contactId)))]
  const [phoneRows, emailRows, addressRows] = await Promise.all([
    listByContacts<PhoneRow>(
      db,
      contactIds,
      `SELECT id, family_contact_id AS contactId, phone, type, type_label AS typeLabel,
              is_primary AS isPrimary, sort_order AS sortOrder
       FROM family_contact_phones`,
    ),
    listByContacts<EmailRow>(
      db,
      contactIds,
      `SELECT id, family_contact_id AS contactId, email, is_primary AS isPrimary, sort_order AS sortOrder
       FROM family_contact_emails`,
    ),
    listByContacts<AddressRow>(
      db,
      contactIds,
      `SELECT id, family_contact_id AS contactId, type, line1, line2, city, state, zip, is_primary AS isPrimary
       FROM family_contact_addresses`,
    ),
  ])
  const phones = group(phoneRows, (row) => Number(row.contactId))
  const emails = group(emailRows, (row) => Number(row.contactId))
  const addresses = group(addressRows, (row) => Number(row.contactId))
  const membersByFamily = group(memberRows, (row) => Number(row.familyId))
  const rightsByChild = group(rightsRows, (row) => Number(row.childId))

  return childRows.map((row) => {
    const childId = Number(row.id)
    const rights = new Map((rightsByChild.get(childId) ?? []).map((rightsRow) => [Number(rightsRow.memberId), rightsRow]))
    const members = (membersByFamily.get(Number(row.familyId)) ?? []).map((member) =>
      toMember(member, phones, emails, addresses, rights.get(Number(member.id)) ?? null),
    )
    return {
      child: { id: childId },
      family: { id: Number(row.familyId), householdPhone: stringValue(row.householdPhone), members },
      stored: storedValues(row),
      hasAdditional: row.additionalId !== null,
    }
  })
}

function mirrorSelect(column: string): string {
  if (column.startsWith('use_')) {
    return `c.\`${column}\` + 0 AS \`${column}\``
  }
  return `c.\`${column}\` AS \`${column}\``
}

async function listByContacts<T extends RowDataPacket>(db: Sql, contactIds: readonly number[], sql: string): Promise<T[]> {
  if (contactIds.length === 0) {
    return []
  }
  return rows<T>(db, `${sql} WHERE family_contact_id IN (${placeholders(contactIds.length)})`, contactIds)
}

function toMember(
  row: MemberRow,
  phones: Map<number, PhoneRow[]>,
  emails: Map<number, EmailRow[]>,
  addresses: Map<number, AddressRow[]>,
  rights: RightsRow | null,
): MirrorMember {
  const contactId = Number(row.contactId)
  return {
    id: Number(row.id),
    contactId,
    status: row.status,
    slot: row.slot,
    slotRank: row.slotRank === null ? null : Number(row.slotRank),
    sortOrder: Number(row.sortOrder),
    isPrimary: flagValue(row.isPrimary),
    contact: {
      fname: stringValue(row.fname),
      lname: stringValue(row.lname),
      legacyFullName: stringValue(row.legacyFullName),
      occupation: stringValue(row.occupation),
      employer: stringValue(row.employer),
      phones: (phones.get(contactId) ?? []).map((phone) => ({
        id: Number(phone.id),
        phone: stringValue(phone.phone),
        type: phone.type,
        typeLabel: phone.typeLabel,
        isPrimary: flagValue(phone.isPrimary),
        sortOrder: Number(phone.sortOrder),
      })),
      emails: (emails.get(contactId) ?? []).map((email) => ({
        id: Number(email.id),
        email: stringValue(email.email),
        isPrimary: flagValue(email.isPrimary),
        sortOrder: Number(email.sortOrder),
      })),
      addresses: (addresses.get(contactId) ?? []).map((address) => ({
        id: Number(address.id),
        type: address.type,
        line1: stringValue(address.line1),
        line2: stringValue(address.line2),
        city: stringValue(address.city),
        state: stringValue(address.state),
        zip: stringValue(address.zip),
        isPrimary: flagValue(address.isPrimary),
      })),
    },
    rights:
      rights === null
        ? null
        : {
            receivesNotifications: flagValue(rights.receivesNotifications),
            notifyMethod: rights.notifyMethod,
            isPaymentResponsible: flagValue(rights.isPaymentResponsible),
          },
  }
}

function storedValues(row: ChildRow): LegacyValues {
  const values: Record<string, string | number | null> = {}
  for (const column of CHILDREN_MIRROR_COLUMNS) {
    if (column.startsWith('use_')) {
      values[column] = Number(row[column]) === 1 ? 1 : 0
    } else if (column.startsWith('notification_')) {
      const method = row[column]
      values[column] = method === 'sms' || method === 'both' ? method : 'voice'
    } else {
      values[column] = stringValue(row[column])
    }
  }
  for (const column of ADDITIONAL_MIRROR_COLUMNS) {
    values[column] = row[column] === null || row[column] === undefined ? null : stringValue(row[column])
  }
  return values as unknown as LegacyValues
}

function stringValue(value: unknown): string {
  return value === null || value === undefined ? '' : String(value)
}

function flagValue(value: unknown): boolean {
  return value === true || value === 1 || value === '1'
}

function group<T>(items: readonly T[], key: (item: T) => number): Map<number, T[]> {
  const grouped = new Map<number, T[]>()
  for (const item of items) {
    const id = key(item)
    const list = grouped.get(id)
    if (list === undefined) {
      grouped.set(id, [item])
    } else {
      list.push(item)
    }
  }
  return grouped
}
