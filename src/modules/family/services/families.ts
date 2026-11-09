import {
  findActiveFamily,
  findFamily,
  listMembers,
  pageFamilies,
  type MemberRow,
} from '../repositories/families.js'
import {
  listAddresses,
  listEmails,
  listPhones,
  type AddressRow,
  type EmailRow,
  type PhoneRow,
} from '../repositories/contacts.js'
import { listChildren, listRights, type RightsRow } from '../repositories/children.js'
import type { Sql } from '../repositories/query.js'
import type { FamilyDetail, FamilyPage, FamilySearchQuery } from '../schemas/family.js'
import { toAddress, toEmail, toPhone, toRights } from './mappers.js'
import { asBoolean, asNumber, asNullableString, asString, contactName, groupBy } from './values.js'

export async function searchFamilies(db: Sql, query: FamilySearchQuery): Promise<FamilyPage> {
  const page = await pageFamilies(db, query.q ?? '', query.page, query.pageSize)
  const familyIds = page.families.map((family) => asNumber(family.id))
  const [members, children] = await Promise.all([
    listMembers(db, familyIds),
    listChildren(db, familyIds),
  ])
  const membersByFamily = groupBy(members, (member) => asNumber(member.familyId))
  const childrenByFamily = groupBy(children, (child) => asNumber(child.familyId))
  return {
    items: page.families.map((family) => {
      const familyMembers = membersByFamily.get(asNumber(family.id)) ?? []
      const familyChildren = (childrenByFamily.get(asNumber(family.id)) ?? []).map((child) => ({
        id: asNumber(child.id),
        fname: asString(child.fname),
        lname: asString(child.lname),
        class: asNumber(child.classId),
      }))
      return {
        id: asNumber(family.id),
        name: asString(family.name),
        householdPhone: asString(family.householdPhone),
        members: familyMembers.map((member) => ({
          name: contactName(asString(member.fname), asString(member.lname), asString(member.legacyFullName)),
          relationship: asString(member.relationship),
          relationshipLabel: asString(member.relationshipLabel),
        })),
        children: familyChildren,
        memberCount: familyMembers.length,
        childCount: familyChildren.length,
      }
    }),
    page: query.page,
    pageSize: query.pageSize,
    total: page.total,
  }
}

export async function getFamily(db: Sql, id: number, includeTrash = false): Promise<FamilyDetail | null> {
  const family = includeTrash ? await findFamily(db, id) : await findActiveFamily(db, id)
  if (family === null) {
    return null
  }
  const members = await listMembers(db, [id])
  const contactIds = members.map((member) => asNumber(member.contactId))
  const memberIds = members.map((member) => asNumber(member.memberId))
  const [phones, emails, addresses, children, rights] = await Promise.all([
    listPhones(db, contactIds),
    listEmails(db, contactIds),
    listAddresses(db, contactIds),
    listChildren(db, [id]),
    listRights(db, memberIds),
  ])
  const phonesByContact = groupBy(phones, (row) => asNumber(row.contactId))
  const emailsByContact = groupBy(emails, (row) => asNumber(row.contactId))
  const addressesByContact = groupBy(addresses, (row) => asNumber(row.contactId))
  const rightsByMember = groupBy(rights, (row) => asNumber(row.memberId))
  return {
    id: asNumber(family.id),
    name: asString(family.name),
    householdPhone: asString(family.householdPhone),
    status: family.status,
    members: members.map((member) => toMember(member, phonesByContact, emailsByContact, addressesByContact, rightsByMember)),
    children: children.map((child) => ({
      id: asNumber(child.id),
      fname: asString(child.fname),
      lname: asString(child.lname),
      class: asNumber(child.classId),
    })),
  }
}

function toMember(
  member: MemberRow,
  phonesByContact: Map<number, PhoneRow[]>,
  emailsByContact: Map<number, EmailRow[]>,
  addressesByContact: Map<number, AddressRow[]>,
  rightsByMember: Map<number, RightsRow[]>,
): FamilyDetail['members'][number] {
  const contactId = asNumber(member.contactId)
  return {
    id: asNumber(member.memberId),
    relationship: asString(member.relationship),
    relationshipLabel: asString(member.relationshipLabel),
    isPrimary: asBoolean(member.isPrimary),
    sortOrder: asNumber(member.sortOrder),
    contact: {
      id: contactId,
      fname: asString(member.fname),
      lname: asString(member.lname),
      legacyFullName: asString(member.legacyFullName),
      hebrewName: asString(member.hebrewName),
      occupation: asString(member.occupation),
      employer: asString(member.employer),
      note: asNullableString(member.note),
      phones: (phonesByContact.get(contactId) ?? []).map(toPhone),
      emails: (emailsByContact.get(contactId) ?? []).map(toEmail),
      addresses: (addressesByContact.get(contactId) ?? []).map(toAddress),
    },
    rights: (rightsByMember.get(asNumber(member.memberId)) ?? []).map(toRights),
  }
}
