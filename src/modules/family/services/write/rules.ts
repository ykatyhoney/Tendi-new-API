import { ApiError } from '../../../../lib/api-error.js'
import { OLD_COLUMN_LIMITS } from '../../schemas/limits.js'
import { joinAddress } from '../mirror/derive.js'

/** Characters, as MariaDB counts them in a utf8mb4 column (not UTF-16 units). */
function characterLength(value: string): number {
  return Array.from(value).length
}

/** "fname lname", without stray spaces. One of the two formats a stored legacy_full_name can be in. */
export function legacyFullName(fname: string, lname: string): string {
  return [fname, lname].filter((part) => part.length > 0).join(' ')
}

/**
 * The legacy format: the first name only, which is what the legacy app keeps in children.father_name and
 * mother_name (all 732 contacts in the dev data). A contact with no first name gets the last name.
 * A new contact is stored this way.
 */
export function newLegacyFullName(fname: string, lname: string): string {
  return fname.length > 0 ? fname : lname
}

/**
 * legacy_full_name after a name change, kept in the format it is stored in: the first name only follows the
 * first name, "fname lname" follows both, and anything else is left as it is. The "fname lname" format must fit
 * the 100-character legacy_full_name and children.father_name / mother_name columns (400 on /fname and /lname);
 * the other two are already within the schema's 100-character name limit.
 */
export function nextLegacyFullName(
  current: { fname: string; lname: string; legacyFullName: string },
  next: { fname: string; lname: string },
): string {
  if (current.legacyFullName === newLegacyFullName(current.fname, current.lname)) {
    return newLegacyFullName(next.fname, next.lname)
  }
  if (current.legacyFullName !== legacyFullName(current.fname, current.lname)) {
    return current.legacyFullName
  }
  const joined = legacyFullName(next.fname, next.lname)
  const max = OLD_COLUMN_LIMITS.fullName
  if (characterLength(joined) > max) {
    const message = `fname + " " + lname must be at most ${max} characters for this contact`
    throw new ApiError(400, 'VALIDATION', `The full name is longer than ${max} characters.`, [
      { path: '/fname', message },
      { path: '/lname', message },
    ])
  }
  return joined
}

export function typeLabelFor(type: string, label: string | null | undefined): string | null {
  const trimmed = label === undefined || label === null ? '' : label.trim()
  if (type !== 'other') {
    if (trimmed.length > 0) {
      throw new ApiError(400, 'TYPE_LABEL_NOT_ALLOWED', 'A type name is allowed only when the type is other.')
    }
    return null
  }
  if (trimmed.length < 1 || trimmed.length > 50) {
    throw new ApiError(400, 'TYPE_LABEL_NOT_ALLOWED', 'An other type needs a name of 1 to 50 characters.')
  }
  return trimmed
}

/** A non-empty list needs exactly one primary. None is a 400; two or more is the same 409 the database gives. */
export function assertOnePrimary(itemCount: number, primaryCount: number): void {
  if (itemCount === 0 || primaryCount === 1) {
    return
  }
  if (primaryCount === 0) {
    throw new ApiError(400, 'PRIMARY_REQUIRED', 'Mark one item in this list as primary.')
  }
  throw new ApiError(409, 'SECOND_PRIMARY', 'This list needs exactly one primary.')
}

/** Trimmed names. A contact needs a first or a last name. legacy_full_name is checked by nextLegacyFullName. */
export function contactNames(fname: string, lname: string): { fname: string; lname: string } {
  const names = { fname: fname.trim(), lname: lname.trim() }
  if (names.fname.length === 0 && names.lname.length === 0) {
    throw new ApiError(400, 'VALIDATION', 'A contact needs a first or last name.', [
      { path: '/fname', message: 'must not be blank when lname is blank' },
    ])
  }
  return names
}

/** Address types that are joined into an old column: home into *_address, work into *_work_address. */
const MIRRORED_ADDRESS_TYPES = new Set(['home', 'work'])
const ADDRESS_PARTS = ['line1', 'line2', 'city', 'state', 'zip'] as const

/** A home or work address must fit the 255-character old column once its parts are joined. */
export function assertJoinedAddressLengths(
  addresses: readonly { type: string; line1: string; line2: string; city: string; state: string; zip: string }[],
): void {
  const max = OLD_COLUMN_LIMITS.joinedAddress
  const details: { path: string; message: string }[] = []
  addresses.forEach((address, index) => {
    if (!MIRRORED_ADDRESS_TYPES.has(address.type) || characterLength(joinAddress(address)) <= max) {
      return
    }
    const message = `the joined address must be at most ${max} characters`
    for (const part of ADDRESS_PARTS) {
      if (address[part].trim().length > 0) {
        details.push({ path: `/addresses/${index}/${part}`, message })
      }
    }
  })
  if (details.length > 0) {
    throw new ApiError(400, 'VALIDATION', `A joined address is longer than ${max} characters.`, details)
  }
}

/**
 * A list may not hold the same value twice. keys[i] is item i's comparison key ('' never matches);
 * every item in a repeated group is reported at /<list>/<i>/<field>.
 */
export function assertNoDuplicates(list: string, field: string, keys: readonly string[]): void {
  const byKey = new Map<string, number[]>()
  keys.forEach((key, index) => {
    if (key.length > 0) {
      byKey.set(key, [...(byKey.get(key) ?? []), index])
    }
  })
  const repeated = [...byKey.values()].filter((indexes) => indexes.length > 1).flat().sort((a, b) => a - b)
  if (repeated.length > 0) {
    throw new ApiError(
      400,
      'DUPLICATE_ITEM',
      `The same ${field} is listed more than once.`,
      repeated.map((index) => ({ path: `/${list}/${index}/${field}`, message: `duplicate ${field}` })),
    )
  }
}

export function requireChange(present: boolean): void {
  if (!present) {
    throw new ApiError(400, 'VALIDATION', 'Nothing to change.')
  }
}
