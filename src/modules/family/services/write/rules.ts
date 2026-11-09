import { ApiError } from '../../../../lib/api-error.js'

export function legacyFullName(fname: string, lname: string): string {
  return [fname, lname].filter((part) => part.length > 0).join(' ')
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

/** Trimmed names. A contact needs a first or a last name. */
export function contactNames(fname: string, lname: string): { fname: string; lname: string } {
  const names = { fname: fname.trim(), lname: lname.trim() }
  if (names.fname.length === 0 && names.lname.length === 0) {
    throw new ApiError(400, 'VALIDATION', 'A contact needs a first or last name.', [
      { path: '/fname', message: 'must not be blank when lname is blank' },
    ])
  }
  return names
}

export function requireChange(present: boolean): void {
  if (!present) {
    throw new ApiError(400, 'VALIDATION', 'Nothing to change.')
  }
}
