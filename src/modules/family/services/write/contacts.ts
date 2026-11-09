import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise'
import { ApiError } from '../../../../lib/api-error.js'
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
  const affected = await withStaffTransaction(pool, staffId, async (connection) => {
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
    return writeMirror(connection, await affectedChildIdsForContact(connection, contactId))
  })
  return finishContact(pool, contactId, affected)
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
}

const PHONES: ListSpec = {
  table: 'family_contact_phones',
  noun: 'phone',
  columns: ['phone', 'type', 'type_label', 'channel', 'is_primary', 'sort_order'],
}

const EMAILS: ListSpec = {
  table: 'family_contact_emails',
  noun: 'email',
  columns: ['email', 'type', 'type_label', 'is_primary', 'sort_order'],
}

const ADDRESSES: ListSpec = {
  table: 'family_contact_addresses',
  noun: 'address',
  columns: ['type', 'type_label', 'line1', 'line2', 'city', 'state', 'zip', 'is_primary'],
}

export async function replacePhones(
  pool: Pool,
  staffId: number,
  contactId: number,
  body: ReplacePhonesBody,
): Promise<ContactWriteResult> {
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
  return replaceList(
    pool,
    staffId,
    contactId,
    ADDRESSES,
    body.addresses.map((address) => {
      const type = address.type ?? 'home'
      return {
        id: address.id,
        values: {
          type,
          type_label: typeLabelFor(type, address.typeLabel),
          line1: address.line1 ?? '',
          line2: address.line2 ?? '',
          city: address.city ?? '',
          state: address.state ?? '',
          zip: address.zip ?? '',
          is_primary: address.isPrimary === true ? 1 : 0,
        },
      }
    }),
  )
}

/**
 * Replaces a contact's phone, email, or address list and keeps row ids where it can.
 * An item with an id updates that row. An item without one keeps an identical existing row, or is inserted.
 * Rows that no item claims are deleted. Only changed columns are written and audited.
 */
async function replaceList(
  pool: Pool,
  staffId: number,
  contactId: number,
  spec: ListSpec,
  items: readonly ListItem[],
): Promise<ContactWriteResult> {
  assertOnePrimary(items.length, items.filter((item) => item.values['is_primary'] === 1).length)
  const affected = await withStaffTransaction(pool, staffId, async (connection) => {
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
    return writeMirror(connection, await affectedChildIdsForContact(connection, contactId))
  })
  return finishContact(pool, contactId, affected)
}

interface ListPlan {
  deletes: number[]
  updates: { id: number; values: ListValues }[]
  inserts: ListValues[]
}

/** Matches items to stored rows: by id first, then an identical unclaimed row. Exported for unit tests. */
export function planList(
  spec: Pick<ListSpec, 'columns' | 'noun'>,
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
  for (const item of items) {
    if (item.id !== undefined) {
      continue
    }
    const same = [...stored.entries()].find(
      ([id, values]) => !claimed.has(id) && sameRow(spec.columns, values, item.values),
    )
    if (same === undefined) {
      unmatched.push(item.values)
    } else {
      claimed.add(same[0])
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
