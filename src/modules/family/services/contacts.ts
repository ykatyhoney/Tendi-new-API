import {
  findActiveContact,
  listAddresses,
  listEmails,
  listHouseholds,
  listPhones,
  pageContacts,
} from '../repositories/contacts.js'
import type { Sql } from '../repositories/query.js'
import type { ContactDetail, ContactPage, ContactSearchQuery } from '../schemas/contact.js'
import { toAddress, toEmail, toPhone } from './mappers.js'
import { asBoolean, asNumber, asNullableString, asString, groupBy } from './values.js'

export async function searchContacts(db: Sql, query: ContactSearchQuery): Promise<ContactPage> {
  const relationships = [...new Set((query.relationship ?? '').split(',').filter((code) => code.length > 0))]
  const page = await pageContacts(db, query.q ?? '', query.page, query.pageSize, relationships)
  const contactIds = page.contacts.map((contact) => asNumber(contact.id))
  const [phones, households] = await Promise.all([
    listPhones(db, contactIds),
    listHouseholds(db, contactIds, { activeOnly: true }),
  ])
  const phonesByContact = groupBy(phones, (row) => asNumber(row.contactId))
  const householdsByContact = groupBy(households, (row) => asNumber(row.contactId))
  return {
    items: page.contacts.map((contact) => {
      const id = asNumber(contact.id)
      return {
        id,
        fname: asString(contact.fname),
        lname: asString(contact.lname),
        legacyFullName: asString(contact.legacyFullName),
        phones: (phonesByContact.get(id) ?? []).map((row) => ({
          phone: asString(row.phone),
          type: row.type,
          isPrimary: asBoolean(row.isPrimary),
        })),
        households: (householdsByContact.get(id) ?? []).map((row) => ({
          familyId: asNumber(row.familyId),
          familyName: asString(row.familyName),
          relationship: asString(row.relationship),
          relationshipLabel: asString(row.relationshipLabel),
        })),
      }
    }),
    page: query.page,
    pageSize: query.pageSize,
    total: page.total,
  }
}

export async function getContact(db: Sql, id: number): Promise<ContactDetail | null> {
  const contact = await findActiveContact(db, id)
  if (contact === null) {
    return null
  }
  const [phones, emails, addresses, households] = await Promise.all([
    listPhones(db, [id]),
    listEmails(db, [id]),
    listAddresses(db, [id]),
    listHouseholds(db, [id]),
  ])
  return {
    id: asNumber(contact.id),
    fname: asString(contact.fname),
    lname: asString(contact.lname),
    legacyFullName: asString(contact.legacyFullName),
    hebrewName: asString(contact.hebrewName),
    occupation: asString(contact.occupation),
    employer: asString(contact.employer),
    note: asNullableString(contact.note),
    phones: phones.map(toPhone),
    emails: emails.map(toEmail),
    addresses: addresses.map(toAddress),
    households: households.map((row) => ({
      familyId: asNumber(row.familyId),
      familyName: asString(row.familyName),
      familyStatus: row.familyStatus,
      memberId: asNumber(row.memberId),
      relationship: asString(row.relationship),
      relationshipLabel: asString(row.relationshipLabel),
      isPrimary: asBoolean(row.isPrimary),
      sortOrder: asNumber(row.sortOrder),
    })),
  }
}
