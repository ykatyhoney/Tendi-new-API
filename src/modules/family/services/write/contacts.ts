import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise'
import { ApiError } from '../../../../lib/api-error.js'
import { withTransaction } from '../../../../lib/with-transaction.js'
import { rows } from '../../repositories/query.js'
import type {
  ContactWriteResult,
  PatchContactBody,
  ReplaceAddressesBody,
  ReplaceEmailsBody,
  ReplacePhonesBody,
} from '../../schemas/contact.js'
import { getContact } from '../contacts.js'
import { affectedChildIdsForContact } from '../mirror/affected.js'
import { writeMirror } from '../mirror/write.js'
import { auditValue, columnChanges, insertId, writeAudit } from './audit.js'
import { lockContactFamilies } from './families.js'
import { assertOnePrimary, legacyFullName, requireChange, typeLabelFor } from './rules.js'

interface ContactRecord extends RowDataPacket {
  id: number
  fname: string
  lname: string
  legacyFullName: string
  hebrewName: string
  occupation: string
  employer: string
  note: string | null
  status: 'active' | 'trash'
}

interface PhoneRecord extends RowDataPacket {
  id: number
  phone: string
  type: string
  typeLabel: string | null
  channel: string
  isPrimary: number
  sortOrder: number
}

interface EmailRecord extends RowDataPacket {
  id: number
  email: string
  type: string
  typeLabel: string | null
  isPrimary: number
  sortOrder: number
}

interface AddressRecord extends RowDataPacket {
  id: number
  type: string
  typeLabel: string | null
  line1: string
  line2: string
  city: string
  state: string
  zip: string
  isPrimary: number
}

export async function patchContact(
  pool: Pool,
  staffId: number,
  contactId: number,
  body: PatchContactBody,
): Promise<ContactWriteResult> {
  requireChange(
    body.fname !== undefined ||
      body.lname !== undefined ||
      body.hebrewName !== undefined ||
      body.occupation !== undefined ||
      body.employer !== undefined ||
      body.note !== undefined,
  )
  const saved = await withTransaction(pool, async (connection) => {
    await connection.query('SET @audit_user = ?', [staffId])
    const current = await lockActiveContact(connection, contactId)
    const fname = body.fname ?? current.fname
    const lname = body.lname ?? current.lname
    const next = {
      fname,
      lname,
      legacy_full_name:
        body.fname !== undefined || body.lname !== undefined
          ? legacyFullName(fname, lname)
          : current.legacyFullName,
      hebrew_name: body.hebrewName ?? current.hebrewName,
      occupation: body.occupation ?? current.occupation,
      employer: body.employer ?? current.employer,
      note: body.note === undefined ? current.note : body.note,
    }
    const changes = columnChanges(
      'family_contacts',
      contactId,
      'update',
      {
        fname: current.fname,
        lname: current.lname,
        legacy_full_name: current.legacyFullName,
        hebrew_name: current.hebrewName,
        occupation: current.occupation,
        employer: current.employer,
        note: current.note,
      },
      next,
    )
    if (changes.length > 0) {
      await connection.query(
        `UPDATE family_contacts
         SET fname = ?, lname = ?, legacy_full_name = ?, hebrew_name = ?, occupation = ?, employer = ?, note = ?,
             updated_at = UTC_TIMESTAMP(), updated_by = ?
         WHERE id = ?`,
        [
          next.fname,
          next.lname,
          next.legacy_full_name,
          next.hebrew_name,
          next.occupation,
          next.employer,
          next.note,
          staffId,
          contactId,
        ],
      )
      await writeAudit(connection, staffId, changes)
    }
    const affected = await writeMirror(connection, await affectedChildIdsForContact(connection, contactId))
    return { affected }
  })
  return finishContact(pool, contactId, saved.affected)
}

export async function replacePhones(
  pool: Pool,
  staffId: number,
  contactId: number,
  body: ReplacePhonesBody,
): Promise<ContactWriteResult> {
  const phones = body.phones.map((phone) => {
    const type = phone.type ?? 'mobile'
    return {
      phone: phone.phone,
      type,
      typeLabel: typeLabelFor(type, phone.typeLabel),
      channel: phone.channel ?? 'sms',
      isPrimary: phone.isPrimary === true ? 1 : 0,
      sortOrder: phone.sortOrder ?? 0,
    }
  })
  assertOnePrimary(phones.length, phones.filter((phone) => phone.isPrimary === 1).length)
  const saved = await withTransaction(pool, async (connection) => {
    await connection.query('SET @audit_user = ?', [staffId])
    await lockActiveContact(connection, contactId)
    const old = await rows<PhoneRecord>(
      connection,
      `SELECT id, phone, type, type_label AS typeLabel, channel, is_primary AS isPrimary, sort_order AS sortOrder
       FROM family_contact_phones WHERE family_contact_id = ? ORDER BY id`,
      [contactId],
    )
    await connection.query(`DELETE FROM family_contact_phones WHERE family_contact_id = ?`, [contactId])
    await writeAudit(
      connection,
      staffId,
      old.flatMap((phone) =>
        columnChanges('family_contact_phones', phone.id, 'delete', phoneValues(phone), blankPhone()),
      ),
    )
    for (const phone of phones) {
      const id = await insertId(
        connection,
        `INSERT INTO family_contact_phones
           (family_contact_id, phone, type, type_label, channel, is_primary, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [contactId, phone.phone, phone.type, phone.typeLabel, phone.channel, phone.isPrimary, phone.sortOrder],
      )
      await writeAudit(
        connection,
        staffId,
        columnChanges('family_contact_phones', id, 'insert', blankPhone(), {
          phone: phone.phone,
          type: phone.type,
          type_label: phone.typeLabel,
          channel: phone.channel,
          is_primary: auditValue(phone.isPrimary),
          sort_order: auditValue(phone.sortOrder),
        }),
      )
    }
    const affected = await writeMirror(connection, await affectedChildIdsForContact(connection, contactId))
    return { affected }
  })
  return finishContact(pool, contactId, saved.affected)
}

export async function replaceEmails(
  pool: Pool,
  staffId: number,
  contactId: number,
  body: ReplaceEmailsBody,
): Promise<ContactWriteResult> {
  const emails = body.emails.map((email) => {
    const type = email.type ?? 'personal'
    return {
      email: email.email,
      type,
      typeLabel: typeLabelFor(type, email.typeLabel),
      isPrimary: email.isPrimary === true ? 1 : 0,
      sortOrder: email.sortOrder ?? 0,
    }
  })
  assertOnePrimary(emails.length, emails.filter((email) => email.isPrimary === 1).length)
  const saved = await withTransaction(pool, async (connection) => {
    await connection.query('SET @audit_user = ?', [staffId])
    await lockActiveContact(connection, contactId)
    const old = await rows<EmailRecord>(
      connection,
      `SELECT id, email, type, type_label AS typeLabel, is_primary AS isPrimary, sort_order AS sortOrder
       FROM family_contact_emails WHERE family_contact_id = ? ORDER BY id`,
      [contactId],
    )
    await connection.query(`DELETE FROM family_contact_emails WHERE family_contact_id = ?`, [contactId])
    await writeAudit(
      connection,
      staffId,
      old.flatMap((email) =>
        columnChanges('family_contact_emails', email.id, 'delete', emailValues(email), blankEmail()),
      ),
    )
    for (const email of emails) {
      const id = await insertId(
        connection,
        `INSERT INTO family_contact_emails
           (family_contact_id, email, type, type_label, is_primary, sort_order)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [contactId, email.email, email.type, email.typeLabel, email.isPrimary, email.sortOrder],
      )
      await writeAudit(
        connection,
        staffId,
        columnChanges('family_contact_emails', id, 'insert', blankEmail(), {
          email: email.email,
          type: email.type,
          type_label: email.typeLabel,
          is_primary: auditValue(email.isPrimary),
          sort_order: auditValue(email.sortOrder),
        }),
      )
    }
    const affected = await writeMirror(connection, await affectedChildIdsForContact(connection, contactId))
    return { affected }
  })
  return finishContact(pool, contactId, saved.affected)
}

export async function replaceAddresses(
  pool: Pool,
  staffId: number,
  contactId: number,
  body: ReplaceAddressesBody,
): Promise<ContactWriteResult> {
  const addresses = body.addresses.map((address) => {
    const type = address.type ?? 'home'
    return {
      type,
      typeLabel: typeLabelFor(type, address.typeLabel),
      line1: address.line1 ?? '',
      line2: address.line2 ?? '',
      city: address.city ?? '',
      state: address.state ?? '',
      zip: address.zip ?? '',
      isPrimary: address.isPrimary === true ? 1 : 0,
    }
  })
  assertOnePrimary(addresses.length, addresses.filter((address) => address.isPrimary === 1).length)
  const saved = await withTransaction(pool, async (connection) => {
    await connection.query('SET @audit_user = ?', [staffId])
    await lockActiveContact(connection, contactId)
    const old = await rows<AddressRecord>(
      connection,
      `SELECT id, type, type_label AS typeLabel, line1, line2, city, state, zip, is_primary AS isPrimary
       FROM family_contact_addresses WHERE family_contact_id = ? ORDER BY id`,
      [contactId],
    )
    await connection.query(`DELETE FROM family_contact_addresses WHERE family_contact_id = ?`, [contactId])
    await writeAudit(
      connection,
      staffId,
      old.flatMap((address) =>
        columnChanges('family_contact_addresses', address.id, 'delete', addressValues(address), blankAddress()),
      ),
    )
    for (const address of addresses) {
      const id = await insertId(
        connection,
        `INSERT INTO family_contact_addresses
           (family_contact_id, type, type_label, line1, line2, city, state, zip, is_primary)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          contactId,
          address.type,
          address.typeLabel,
          address.line1,
          address.line2,
          address.city,
          address.state,
          address.zip,
          address.isPrimary,
        ],
      )
      await writeAudit(
        connection,
        staffId,
        columnChanges('family_contact_addresses', id, 'insert', blankAddress(), {
          type: address.type,
          type_label: address.typeLabel,
          line1: address.line1,
          line2: address.line2,
          city: address.city,
          state: address.state,
          zip: address.zip,
          is_primary: auditValue(address.isPrimary),
        }),
      )
    }
    const affected = await writeMirror(connection, await affectedChildIdsForContact(connection, contactId))
    return { affected }
  })
  return finishContact(pool, contactId, saved.affected)
}

async function finishContact(pool: Pool, contactId: number, affected: number[]): Promise<ContactWriteResult> {
  const contact = await getContact(pool, contactId)
  if (contact === null) {
    throw new ApiError(500, 'INTERNAL', 'Contact could not be read after it was saved.')
  }
  return { contact, affected_child_ids: affected }
}

async function lockActiveContact(connection: PoolConnection, contactId: number): Promise<ContactRecord> {
  await lockContactFamilies(connection, contactId)
  const found = await rows<ContactRecord>(
    connection,
    `SELECT id, fname, lname, legacy_full_name AS legacyFullName, hebrew_name AS hebrewName,
            occupation, employer, note, status
     FROM family_contacts WHERE id = ?`,
    [contactId],
  )
  const contact = found[0]
  if (contact === undefined || contact.status !== 'active') {
    throw new ApiError(404, 'NOT_FOUND', 'Contact not found')
  }
  return contact
}

function phoneValues(phone: PhoneRecord): Record<string, string | null> {
  return {
    phone: phone.phone,
    type: phone.type,
    type_label: phone.typeLabel,
    channel: phone.channel,
    is_primary: auditValue(phone.isPrimary),
    sort_order: auditValue(phone.sortOrder),
  }
}

function blankPhone(): Record<string, string | null> {
  return { phone: null, type: null, type_label: null, channel: null, is_primary: null, sort_order: null }
}

function emailValues(email: EmailRecord): Record<string, string | null> {
  return {
    email: email.email,
    type: email.type,
    type_label: email.typeLabel,
    is_primary: auditValue(email.isPrimary),
    sort_order: auditValue(email.sortOrder),
  }
}

function blankEmail(): Record<string, string | null> {
  return { email: null, type: null, type_label: null, is_primary: null, sort_order: null }
}

function addressValues(address: AddressRecord): Record<string, string | null> {
  return {
    type: address.type,
    type_label: address.typeLabel,
    line1: address.line1,
    line2: address.line2,
    city: address.city,
    state: address.state,
    zip: address.zip,
    is_primary: auditValue(address.isPrimary),
  }
}

function blankAddress(): Record<string, string | null> {
  return {
    type: null,
    type_label: null,
    line1: null,
    line2: null,
    city: null,
    state: null,
    zip: null,
    is_primary: null,
  }
}
