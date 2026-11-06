import type { Pool } from 'mysql2/promise'
import {
  findActiveFamily,
  findFamily,
  listMembers,
  pageFamilies,
  searchFamilyIds,
  type MemberRow,
} from '../repositories/families.js'
import { listAddresses, listEmails, listPhones } from '../repositories/contacts.js'
import { listChildren, listRights } from '../repositories/children.js'
import type { FamilyDetail, FamilyPage, FamilySearchQuery } from '../schemas/family.js'
import { asBoolean, asNumber, asNullableString, asString, contactName, groupBy } from './values.js'

export async function searchFamilies(db: Pool, query: FamilySearchQuery): Promise<FamilyPage> {
  const ids = await searchFamilyIds(db, query.q ?? '')
  const page = await pageFamilies(db, ids, query.page, query.pageSize)
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

export async function getFamily(db: Pool, id: number, includeTrash = false): Promise<FamilyDetail | null> {
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
  phonesByContact: Map<number, { id: number; phone: string; type: 'mobile' | 'home' | 'work' | 'other'; typeLabel: string | null; channel: 'none' | 'sms' | 'voice' | 'both'; isPrimary: number; sortOrder: number }[]>,
  emailsByContact: Map<number, { id: number; email: string; type: 'personal' | 'work' | 'other'; typeLabel: string | null; isPrimary: number; sortOrder: number }[]>,
  addressesByContact: Map<number, { id: number; type: 'home' | 'work' | 'billing' | 'other'; typeLabel: string | null; line1: string; line2: string; city: string; state: string; zip: string; isPrimary: number }[]>,
  rightsByMember: Map<number, { id: number; childId: number; receivesNotifications: number; notifyMethod: 'sms' | 'voice' | 'both'; mayCollect: number; collectFrom: string | null; collectTo: string | null; isEmergency: number; isPaymentResponsible: number }[]>,
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
      phones: (phonesByContact.get(contactId) ?? []).map((row) => ({
        id: asNumber(row.id),
        phone: asString(row.phone),
        type: row.type,
        typeLabel: asNullableString(row.typeLabel),
        channel: row.channel,
        isPrimary: asBoolean(row.isPrimary),
        sortOrder: asNumber(row.sortOrder),
      })),
      emails: (emailsByContact.get(contactId) ?? []).map((row) => ({
        id: asNumber(row.id),
        email: asString(row.email),
        type: row.type,
        typeLabel: asNullableString(row.typeLabel),
        isPrimary: asBoolean(row.isPrimary),
        sortOrder: asNumber(row.sortOrder),
      })),
      addresses: (addressesByContact.get(contactId) ?? []).map((row) => ({
        id: asNumber(row.id),
        type: row.type,
        typeLabel: asNullableString(row.typeLabel),
        line1: asString(row.line1),
        line2: asString(row.line2),
        city: asString(row.city),
        state: asString(row.state),
        zip: asString(row.zip),
        isPrimary: asBoolean(row.isPrimary),
      })),
    },
    rights: (rightsByMember.get(asNumber(member.memberId)) ?? []).map((row) => ({
      id: asNumber(row.id),
      childId: asNumber(row.childId),
      receivesNotifications: asBoolean(row.receivesNotifications),
      notifyMethod: row.notifyMethod,
      mayCollect: asBoolean(row.mayCollect),
      collectFrom: asNullableString(row.collectFrom),
      collectTo: asNullableString(row.collectTo),
      isEmergency: asBoolean(row.isEmergency),
      isPaymentResponsible: asBoolean(row.isPaymentResponsible),
    })),
  }
}
