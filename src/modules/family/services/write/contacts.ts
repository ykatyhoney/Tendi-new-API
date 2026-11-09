import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise'
import { ApiError } from '../../../../lib/api-error.js'
import { normalizedPhone } from '../../../../lib/phone.js'
import { quoteIdentifier } from '../../../../lib/sql.js'
import { withStaffTransaction } from '../../../../lib/with-transaction.js'
import { placeholders, rows } from '../../repositories/query.js'
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
import { auditValue, columnChanges, insertId, writeAudit, type AuditChange } from './audit.js'
import { lockContactFamilies } from './families.js'
import {
  assertJoinedAddressLengths,
  assertNoDuplicates,
  assertOnePrimary,
  contactNames,
  nextLegacyFullName,
  requireChange,
  typeLabelFor,
} from './rules.js'

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
  return withStaffTransaction(pool, staffId, async (connection) => {
    const current = await lockActiveContact(connection, contactId)
    const namesChanged = body.fname !== undefined || body.lname !== undefined
    // Stored names are kept as they are unless this save changes one of them.
    const { fname, lname } = namesChanged
      ? contactNames(body.fname ?? current.fname, body.lname ?? current.lname)
      : { fname: current.fname, lname: current.lname }
    const next = {
      fname,
      lname,
      // Kept in the format it is stored in (the legacy format is the first name only).
      legacy_full_name: namesChanged
        ? nextLegacyFullName(
            { fname: current.fname, lname: current.lname, legacyFullName: current.legacyFullName },
            { fname, lname },
          )
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
    return finishContact(connection, contactId, affected)
  })
}

type ListTable = 'family_contact_phones' | 'family_contact_emails' | 'family_contact_addresses'

/** One row of a contact's phone, email, or address list, keyed by column name. */
type ListValues = Record<string, string | number | null>

interface ListItem {
  id: number | undefined
  values: ListValues
}

interface ListSpec {
  table: ListTable
  /** What the list holds, for error messages. */
  noun: string
  /** Every written column except id and family_contact_id. is_primary must be one of them. */
  columns: readonly string[]
  /** The value an item without an id is matched on: two rows with the same key are the same phone, email or address. */
  key?: (values: ListValues) => string
}

const text = (value: string | number | null | undefined): string => (value === null || value === undefined ? '' : String(value))

/** phone_normalized, or the raw phone when that is empty (fewer than ten digits). */
export function phoneKey(phone: string): string {
  const normalized = normalizedPhone(phone)
  return normalized === '' ? phone : normalized
}

export function emailKey(email: string): string {
  return email.trim().toLowerCase()
}

const PHONES: ListSpec = {
  table: 'family_contact_phones',
  noun: 'phone',
  columns: ['phone', 'type', 'type_label', 'channel', 'is_primary', 'sort_order'],
  key: (values) => phoneKey(text(values['phone'])),
}

const EMAILS: ListSpec = {
  table: 'family_contact_emails',
  noun: 'email',
  columns: ['email', 'type', 'type_label', 'is_primary', 'sort_order'],
  key: (values) => emailKey(text(values['email'])),
}

const ADDRESSES: ListSpec = {
  table: 'family_contact_addresses',
  noun: 'address',
  columns: ['type', 'type_label', 'line1', 'line2', 'city', 'state', 'zip', 'is_primary'],
  key: (values) => ['type', 'line1', 'line2', 'city', 'state', 'zip'].map((column) => text(values[column])).join('\u0000'),
}

export async function replacePhones(
  pool: Pool,
  staffId: number,
  contactId: number,
  body: ReplacePhonesBody,
): Promise<ContactWriteResult> {
  assertNoDuplicates('phones', 'phone', body.phones.map((phone) => phoneKey(phone.phone)))
  return replaceList(
    pool,
    staffId,
    contactId,
    PHONES,
    body.phones.map((phone) => {
      const type = phone.type ?? 'mobile'
      return {
        id: phone.id,
        values: {
          phone: phone.phone,
          type,
          type_label: typeLabelFor(type, phone.typeLabel),
          channel: phone.channel ?? 'sms',
          is_primary: phone.isPrimary === true ? 1 : 0,
          sort_order: phone.sortOrder ?? 0,
        },
      }
    }),
  )
}

export async function replaceEmails(
  pool: Pool,
  staffId: number,
  contactId: number,
  body: ReplaceEmailsBody,
): Promise<ContactWriteResult> {
  assertNoDuplicates('emails', 'email', body.emails.map((email) => emailKey(email.email)))
  return replaceList(
    pool,
    staffId,
    contactId,
    EMAILS,
    body.emails.map((email) => {
      const type = email.type ?? 'personal'
      return {
        id: email.id,
        values: {
          email: email.email,
          type,
          type_label: typeLabelFor(type, email.typeLabel),
          is_primary: email.isPrimary === true ? 1 : 0,
          sort_order: email.sortOrder ?? 0,
        },
      }
    }),
  )
}

export async function replaceAddresses(
  pool: Pool,
  staffId: number,
  contactId: number,
  body: ReplaceAddressesBody,
): Promise<ContactWriteResult> {
  const addresses = body.addresses.map((address) => ({
    ...address,
    type: address.type ?? 'home',
    line1: address.line1 ?? '',
    line2: address.line2 ?? '',
    city: address.city ?? '',
    state: address.state ?? '',
    zip: address.zip ?? '',
  }))
  assertJoinedAddressLengths(addresses)
  return replaceList(
    pool,
    staffId,
    contactId,
    ADDRESSES,
    addresses.map((address) => {
      const type = address.type
      return {
        id: address.id,
        values: {
          type,
          type_label: typeLabelFor(type, address.typeLabel),
          line1: address.line1,
          line2: address.line2,
          city: address.city,
          state: address.state,
          zip: address.zip,
          is_primary: address.isPrimary === true ? 1 : 0,
        },
      }
    }),
  )
}

/**
 * Replaces a contact's phone, email, or address list and keeps row ids where it can.
 * An item with an id updates that row. An item without one is matched to a stored row by its value (the spec's
 * key) and updates the columns that differ, or is inserted. Rows that no item claims are deleted. Only changed
 * columns are written and audited.
 */
async function replaceList(
  pool: Pool,
  staffId: number,
  contactId: number,
  spec: ListSpec,
  items: readonly ListItem[],
): Promise<ContactWriteResult> {
  assertOnePrimary(items.length, items.filter((item) => item.values['is_primary'] === 1).length)
  return withStaffTransaction(pool, staffId, async (connection) => {
    await lockActiveContact(connection, contactId)
    const existing = await rows<RowDataPacket>(
      connection,
      `SELECT id, ${spec.columns.map((column) => quoteIdentifier(column)).join(', ')}
       FROM ${quoteIdentifier(spec.table)}
       WHERE family_contact_id = ?
       ORDER BY id
       FOR UPDATE`,
      [contactId],
    )
    const stored = new Map<number, ListValues>(
      existing.map((row) => [Number(row['id']), pick(spec.columns, row)]),
    )
    const plan = planList(spec, stored, items)
    const changes: AuditChange[] = []

    if (plan.deletes.length > 0) {
      await connection.query(
        `DELETE FROM ${quoteIdentifier(spec.table)} WHERE id IN (${placeholders(plan.deletes.length)})`,
        plan.deletes,
      )
      for (const id of plan.deletes) {
        changes.push(...columnChanges(spec.table, id, 'delete', auditRow(stored.get(id) ?? {}), blankRow(spec)))
      }
    }

    // Demotions run before the new primary is written, so the one-primary key never sees two.
    const updates = [...plan.updates].sort(
      (left, right) => Number(left.values['is_primary']) - Number(right.values['is_primary']),
    )
    for (const update of updates) {
      const before = stored.get(update.id) ?? {}
      const columns = spec.columns.filter((column) => auditValue(before[column] ?? null) !== auditValue(update.values[column] ?? null))
      if (columns.length === 0) {
        continue
      }
      await connection.query(
        `UPDATE ${quoteIdentifier(spec.table)}
         SET ${columns.map((column) => `${quoteIdentifier(column)} = ?`).join(', ')}
         WHERE id = ?`,
        [...columns.map((column) => update.values[column] ?? null), update.id],
      )
      changes.push(...columnChanges(spec.table, update.id, 'update', auditRow(before), auditRow(update.values)))
    }

    for (const values of plan.inserts) {
      const id = await insertId(
        connection,
        `INSERT INTO ${quoteIdentifier(spec.table)}
           (family_contact_id, ${spec.columns.map((column) => quoteIdentifier(column)).join(', ')})
         VALUES (?, ${placeholders(spec.columns.length)})`,
        [contactId, ...spec.columns.map((column) => values[column] ?? null)],
      )
      changes.push(...columnChanges(spec.table, id, 'insert', blankRow(spec), auditRow(values)))
    }

    await writeAudit(connection, staffId, changes)
    const affected = await writeMirror(connection, await affectedChildIdsForContact(connection, contactId))
    return finishContact(connection, contactId, affected)
  })
}

interface ListPlan {
  deletes: number[]
  updates: { id: number; values: ListValues }[]
  inserts: ListValues[]
}

/**
 * Matches items to stored rows: by id first, then an id-less item to an unclaimed row with the same value
 * (an identical row first, else the lowest id). Exported for unit tests.
 */
export function planList(
  spec: Pick<ListSpec, 'columns' | 'noun' | 'key'>,
  stored: ReadonlyMap<number, ListValues>,
  items: readonly ListItem[],
): ListPlan {
  const claimed = new Set<number>()
  const updates: ListPlan['updates'] = []
  const unmatched: ListValues[] = []
  for (const item of items) {
    if (item.id === undefined) {
      continue
    }
    if (!stored.has(item.id)) {
      throw new ApiError(400, 'VALIDATION', `Unknown ${spec.noun} id ${item.id} for this contact.`)
    }
    if (claimed.has(item.id)) {
      throw new ApiError(400, 'VALIDATION', `The ${spec.noun} id ${item.id} is listed twice.`)
    }
    claimed.add(item.id)
    updates.push({ id: item.id, values: item.values })
  }
  const idless = items.filter((item) => item.id === undefined)
  const pending: ListItem[] = []
  // Identical rows first, so a value match below never takes a row that another item is identical to.
  for (const item of idless) {
    const same = [...stored.entries()].find(([id, values]) => !claimed.has(id) && sameRow(spec.columns, values, item.values))
    if (same === undefined) {
      pending.push(item)
    } else {
      claimed.add(same[0])
    }
  }
  const key = spec.key
  for (const item of pending) {
    const byValue =
      key === undefined
        ? undefined
        : [...stored.entries()].find(([id, values]) => !claimed.has(id) && key(values) === key(item.values))
    if (byValue === undefined) {
      unmatched.push(item.values)
    } else {
      claimed.add(byValue[0])
      updates.push({ id: byValue[0], values: item.values })
    }
  }
  const deletes = [...stored.keys()].filter((id) => !claimed.has(id))
  return { deletes, updates, inserts: unmatched }
}

function sameRow(columns: readonly string[], left: ListValues, right: ListValues): boolean {
  return columns.every((column) => auditValue(left[column] ?? null) === auditValue(right[column] ?? null))
}

function pick(columns: readonly string[], row: RowDataPacket): ListValues {
  const values: ListValues = {}
  for (const column of columns) {
    const value: unknown = row[column]
    values[column] = value === null || value === undefined ? null : typeof value === 'number' ? value : String(value)
  }
  return values
}

function auditRow(values: ListValues): Record<string, string | null> {
  return Object.fromEntries(Object.entries(values).map(([column, value]) => [column, auditValue(value)]))
}

function blankRow(spec: ListSpec): Record<string, string | null> {
  return Object.fromEntries(spec.columns.map((column) => [column, null]))
}

/** Read inside the save's transaction, so the response is what this save committed, or nothing is committed. */
async function finishContact(connection: PoolConnection, contactId: number, affected: number[]): Promise<ContactWriteResult> {
  const contact = await getContact(connection, contactId)
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
