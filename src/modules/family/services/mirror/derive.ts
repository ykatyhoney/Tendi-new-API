import { ApiError } from '../../../../lib/api-error.js'
import {
  ADDITIONAL_MIRROR_COLUMNS,
  CHILDREN_MIRROR_COLUMNS,
  type AddressType,
  type LegacyColumn,
  type LegacyValues,
  type MirrorAddress,
  type MirrorChild,
  type MirrorContact,
  type MirrorEmail,
  type MirrorFamily,
  type MirrorMember,
  type MirrorPhone,
  type ParentSlot,
  type PhoneType,
} from './types.js'

/**
 * These columns are NULL when the new value is empty. The others are ''.
 * That is how the linked rows are stored today.
 */
const NULL_WHEN_EMPTY = new Set<LegacyColumn>([
  'father_work_address',
  'father_employer',
  'mother_office_phone',
  'mother_work_address',
  'mother_occupation',
  'mother_employer',
])

export function deriveLegacyValues(child: MirrorChild, family: MirrorFamily): LegacyValues {
  void child
  const father = parent(family, 'father')
  const mother = parent(family, 'mother')
  const fatherContact = father?.contact
  const motherContact = mother?.contact
  return {
    father_name: fatherContact?.legacyFullName ?? '',
    mother_name: motherContact?.legacyFullName ?? '',
    father_phone: fatherContact === undefined ? '' : phoneOf(fatherContact, 'mobile'),
    mother_phone: motherContact === undefined ? '' : phoneOf(motherContact, 'mobile'),
    home_phone: family.householdPhone,
    parent_email: paymentEmail(family),
    use_father_phone_for_notification: flag(father),
    use_mother_phone_for_notification: flag(mother),
    notification_father_phone_method: father?.rights?.notifyMethod ?? 'voice',
    notification_mother_phone_method: mother?.rights?.notifyMethod ?? 'voice',
    father_fname: fatherContact?.fname ?? '',
    father_lname: fatherContact?.lname ?? '',
    father_email: fatherContact === undefined ? '' : primaryEmail(fatherContact),
    father_home_phone: homePhone(fatherContact, family.householdPhone),
    father_office_phone: fatherContact === undefined ? '' : phoneOf(fatherContact, 'work'),
    father_address: fatherContact === undefined ? '' : addressOf(fatherContact, 'home'),
    father_occupation: fatherContact?.occupation ?? '',
    father_work_address: blank('father_work_address', fatherContact === undefined ? '' : addressOf(fatherContact, 'work')),
    father_employer: blank('father_employer', fatherContact?.employer ?? ''),
    mother_fname: motherContact?.fname ?? '',
    mother_lname: motherContact?.lname ?? '',
    mother_email: motherContact === undefined ? '' : primaryEmail(motherContact),
    mother_home_phone: homePhone(motherContact, family.householdPhone),
    mother_address: motherContact === undefined ? '' : addressOf(motherContact, 'home'),
    mother_office_phone: blank('mother_office_phone', motherContact === undefined ? '' : phoneOf(motherContact, 'work')),
    mother_work_address: blank('mother_work_address', motherContact === undefined ? '' : addressOf(motherContact, 'work')),
    mother_occupation: blank('mother_occupation', motherContact?.occupation ?? ''),
    mother_employer: blank('mother_employer', motherContact?.employer ?? ''),
  }
}

/** '' and NULL are the same empty cell. A few linked rows use one, the rest use the other. */
export function sameLegacyValue(stored: string | number | null, derived: string | number | null): boolean {
  const storedEmpty = stored === null || stored === ''
  const derivedEmpty = derived === null || derived === ''
  if (storedEmpty || derivedEmpty) {
    return storedEmpty && derivedEmpty
  }
  return String(stored) === String(derived)
}

/**
 * The value a column holds after the mirror runs: the stored value when it already equals the derived one
 * (writeMirror writes only changed columns, so a stored '' stays '' where the derived value is NULL), else the
 * derived value. A child with no children_additional_information row gets that row inserted with the derived
 * values, so pass insertsRow for its columns. The link preview's "after" uses this.
 */
export function valueAfterMirror(
  stored: string | number | null,
  derived: string | number | null,
  insertsRow = false,
): string | number | null {
  return !insertsRow && sameLegacyValue(stored, derived) ? stored : derived
}

export function legacyColumnValue(values: LegacyValues, column: LegacyColumn): string | number | null {
  return values[column]
}

export function characterLength(value: string): number {
  return Array.from(value).length
}

export function valueTooLong(
  values: LegacyValues,
  lengths: ReadonlyMap<string, number>,
): { column: LegacyColumn; max: number } | null {
  for (const column of [...CHILDREN_MIRROR_COLUMNS, ...ADDITIONAL_MIRROR_COLUMNS]) {
    const max = lengths.get(column)
    const value = values[column]
    if (max === undefined || typeof value !== 'string') {
      continue
    }
    if (characterLength(value) > max) {
      return { column, max }
    }
  }
  return null
}

export function assertLegacyLengths(values: LegacyValues, lengths: ReadonlyMap<string, number>): void {
  const tooLong = valueTooLong(values, lengths)
  if (tooLong === null) {
    return
  }
  throw new ApiError(
    409,
    'VALUE_TOO_LONG',
    `${tooLong.column} is longer than ${tooLong.max} characters`,
    { column: tooLong.column },
  )
}

function parent(family: MirrorFamily, slot: ParentSlot): MirrorMember | null {
  const candidates = family.members.filter((member) => member.status === 'active' && member.slot === slot)
  candidates.sort(
    (a, b) => (a.slotRank ?? 99) - (b.slotRank ?? 99) || a.sortOrder - b.sortOrder || a.id - b.id,
  )
  return candidates[0] ?? null
}

function flag(member: MirrorMember | null): 0 | 1 {
  return member?.rights?.receivesNotifications === true ? 1 : 0
}

function homePhone(contact: MirrorContact | undefined, householdPhone: string): string {
  if (contact === undefined) {
    return ''
  }
  const home = phoneOf(contact, 'home')
  return home === '' ? householdPhone : home
}

function phoneOf(contact: MirrorContact, type: PhoneType): string {
  const matches = contact.phones.filter((phone) => phone.type === type)
  matches.sort(byPrimaryThenOrder)
  return matches[0]?.phone ?? ''
}

function primaryEmail(contact: MirrorContact): string {
  const emails = [...contact.emails]
  emails.sort(byPrimaryThenOrder)
  const primary = emails.find((email) => email.isPrimary)
  return primary?.email ?? ''
}

function addressOf(contact: MirrorContact, type: AddressType): string {
  const matches = contact.addresses.filter((address) => address.type === type)
  matches.sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary) || a.id - b.id)
  const address = matches[0]
  return address === undefined ? '' : joinAddress(address)
}

/** The old address text: line1, line2, city, "state zip", with empty parts left out. */
export function joinAddress(address: Pick<MirrorAddress, 'line1' | 'line2' | 'city' | 'state' | 'zip'>): string {
  const stateZip = [address.state, address.zip].map((part) => part.trim()).filter((part) => part.length > 0).join(' ')
  return [address.line1, address.line2, address.city, stateZip]
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join(', ')
}

/** The payer's primary email. If the payer has none, or there is no payer, the main contact's primary email. */
function paymentEmail(family: MirrorFamily): string {
  const active = family.members.filter((member) => member.status === 'active')
  const payers = active.filter((member) => member.rights?.isPaymentResponsible === true)
  payers.sort(byMemberOrder)
  const payer = payers[0]
  const payerEmail = payer === undefined ? '' : primaryEmail(payer.contact)
  if (payerEmail !== '') {
    return payerEmail
  }
  const mains = active.filter((member) => member.isPrimary)
  mains.sort(byMemberOrder)
  const main = mains[0]
  return main === undefined ? '' : primaryEmail(main.contact)
}

function blank(column: LegacyColumn, value: string): string | null {
  if (value !== '') {
    return value
  }
  return NULL_WHEN_EMPTY.has(column) ? null : value
}

function byPrimaryThenOrder(a: MirrorPhone | MirrorEmail, b: MirrorPhone | MirrorEmail): number {
  return Number(b.isPrimary) - Number(a.isPrimary) || a.sortOrder - b.sortOrder || a.id - b.id
}

function byMemberOrder(a: MirrorMember, b: MirrorMember): number {
  return a.sortOrder - b.sortOrder || a.id - b.id
}
