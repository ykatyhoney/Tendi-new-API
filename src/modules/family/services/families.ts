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
import { listChildren, listRights, type ChildRow, type RightsRow } from '../repositories/children.js'
import type { Sql } from '../repositories/query.js'
import type { FamilyDetail, FamilyPage, FamilySearchQuery } from '../schemas/family.js'
import type { ParentSlot } from './mirror/types.js'
import { joinAddress, mirrorSlots } from './mirror/derive.js'
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
  const mainContacts = new Map<number, number>()
  for (const [familyId, familyMembers] of membersByFamily) {
    const main = familyMembers.find((member) => asBoolean(member.isPrimary))
    if (main !== undefined) {
      mainContacts.set(familyId, asNumber(main.contactId))
    }
  }
  const addresses = await listAddresses(db, [...new Set(mainContacts.values())])
  const addressesByContact = groupBy(addresses, (row) => asNumber(row.contactId))
  return {
    items: page.families.map((family) => {
      const familyId = asNumber(family.id)
      const familyMembers = membersByFamily.get(familyId) ?? []
      const familyChildren = (childrenByFamily.get(familyId) ?? []).map(toChildSummary)
      const mainContactId = mainContacts.get(familyId)
      const slots = slotsOf(familyMembers)
      return {
        id: familyId,
        name: asString(family.name),
        householdPhone: asString(family.householdPhone),
        address: mainContactId === undefined ? '' : homeAddress(addressesByContact.get(mainContactId) ?? []),
        members: familyMembers.map((member) => ({
          name: contactName(asString(member.fname), asString(member.lname), asString(member.legacyFullName)),
          relationship: asString(member.relationship),
          relationshipLabel: asString(member.relationshipLabel),
          mirrorSlot: slots.get(asNumber(member.memberId)) ?? null,
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

function toChildSummary(child: ChildRow): FamilyDetail['children'][number] {
  return {
    id: asNumber(child.id),
    fname: asString(child.fname),
    lname: asString(child.lname),
    class: asNumber(child.classId),
    status: child.status === 'trash' || child.status === 'inactive' ? child.status : 'active',
  }
}

/** Member id -> father or mother, by the mirror's rule. listMembers returns active members only, which is what the mirror picks from. */
function slotsOf(members: readonly MemberRow[]): Map<number, ParentSlot> {
  return mirrorSlots(
    members.map((member) => ({
      id: asNumber(member.memberId),
      status: 'active' as const,
      slot: member.parentSlot,
      slotRank: member.slotRank === null ? null : asNumber(member.slotRank),
      sortOrder: asNumber(member.sortOrder),
    })),
  )
}

/** A contact's home address, primary first (listAddresses orders by is_primary DESC, id), as the mirror joins it. */
function homeAddress(rows: readonly AddressRow[]): string {
  const home = rows.find((row) => row.type === 'home')
  return home === undefined
    ? ''
    : joinAddress({
        line1: asString(home.line1),
        line2: asString(home.line2),
        city: asString(home.city),
        state: asString(home.state),
        zip: asString(home.zip),
      })
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
    // Every linked child, a trashed one included (marked by its status), so the page can offer to unlink it.
    listChildren(db, [id], { includeTrashed: true }),
    listRights(db, memberIds),
  ])
  const phonesByContact = groupBy(phones, (row) => asNumber(row.contactId))
  const emailsByContact = groupBy(emails, (row) => asNumber(row.contactId))
  const addressesByContact = groupBy(addresses, (row) => asNumber(row.contactId))
  const rightsByMember = groupBy(rights, (row) => asNumber(row.memberId))
  const slots = slotsOf(members)
  return {
    id: asNumber(family.id),
    name: asString(family.name),
    householdPhone: asString(family.householdPhone),
    status: family.status,
    members: members.map((member) =>
      toMember(member, slots.get(asNumber(member.memberId)) ?? null, phonesByContact, emailsByContact, addressesByContact, rightsByMember),
    ),
    children: children.map(toChildSummary),
  }
}

function toMember(
  member: MemberRow,
  mirrorSlot: ParentSlot | null,
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
    mirrorSlot,
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
