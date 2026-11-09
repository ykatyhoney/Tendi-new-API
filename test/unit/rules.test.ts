import { describe, expect, it } from 'vitest'
import { ApiError } from '../../src/lib/api-error.js'
import {
  assertOnePrimary,
  contactNames,
  legacyFullName,
  newLegacyFullName,
  nextLegacyFullName,
  requireChange,
  typeLabelFor,
} from '../../src/modules/family/services/write/rules.js'

function codeOf(run: () => unknown): string | undefined {
  try {
    run()
  } catch (error) {
    return error instanceof ApiError ? `${error.statusCode} ${error.code}` : 'not an ApiError'
  }
  return undefined
}

describe('write rules', () => {
  it('needs exactly one primary in a non-empty list', () => {
    expect(codeOf(() => assertOnePrimary(0, 0))).toBeUndefined()
    expect(codeOf(() => assertOnePrimary(3, 1))).toBeUndefined()
    expect(codeOf(() => assertOnePrimary(2, 0))).toBe('400 PRIMARY_REQUIRED')
    expect(codeOf(() => assertOnePrimary(2, 2))).toBe('409 SECOND_PRIMARY')
  })

  it('trims names and needs a first or last name', () => {
    expect(contactNames('  Rochel ', ' Dorfman')).toEqual({ fname: 'Rochel', lname: 'Dorfman' })
    expect(contactNames('', 'Dorfman')).toEqual({ fname: '', lname: 'Dorfman' })
    expect(codeOf(() => contactNames('  ', ''))).toBe('400 VALIDATION')
  })

  it('joins the legacy full name without stray spaces', () => {
    expect(legacyFullName('Yechiel', 'Dorfman')).toBe('Yechiel Dorfman')
    expect(legacyFullName('', 'Dorfman')).toBe('Dorfman')
  })

  it('keeps legacy_full_name in its stored format when a name changes', () => {
    const current = { fname: 'Yechiel', lname: 'Dorfman' }
    // The legacy format: the first name only (all 732 contacts in the dev data).
    expect(nextLegacyFullName({ ...current, legacyFullName: 'Yechiel' }, { fname: 'Yechiel', lname: 'Katz' })).toBe('Yechiel')
    expect(nextLegacyFullName({ ...current, legacyFullName: 'Yechiel' }, { fname: 'Chiel', lname: 'Dorfman' })).toBe('Chiel')
    // "fname lname" follows both names.
    expect(nextLegacyFullName({ ...current, legacyFullName: 'Yechiel Dorfman' }, { fname: 'Yechiel', lname: 'Katz' })).toBe(
      'Yechiel Katz',
    )
    // Anything else is left as it is.
    expect(nextLegacyFullName({ ...current, legacyFullName: 'Reb Yechiel' }, { fname: 'Chiel', lname: 'Katz' })).toBe('Reb Yechiel')
    // With no last name both formats are the same, and the first-name format wins.
    expect(nextLegacyFullName({ fname: 'Yechiel', lname: '', legacyFullName: 'Yechiel' }, { fname: 'Yechiel', lname: 'Katz' })).toBe(
      'Yechiel',
    )
  })

  it('gives a new contact the first name as legacy_full_name, or the last name when there is no first name', () => {
    expect(newLegacyFullName('Yechiel', 'Dorfman')).toBe('Yechiel')
    expect(newLegacyFullName('', 'Dorfman')).toBe('Dorfman')
  })

  it('refuses a "fname lname" legacy_full_name over 100 characters, on /fname and /lname', () => {
    const current = { fname: 'A', lname: 'B', legacyFullName: 'A B' }
    expect(codeOf(() => nextLegacyFullName(current, { fname: 'a'.repeat(60), lname: 'b'.repeat(60) }))).toBe('400 VALIDATION')
    expect(nextLegacyFullName(current, { fname: 'a'.repeat(50), lname: 'b'.repeat(49) })).toHaveLength(100)
    // The first-name format stores fname only, which the schema already limits to 100.
    expect(nextLegacyFullName({ ...current, legacyFullName: 'A' }, { fname: 'a'.repeat(60), lname: 'b'.repeat(60) })).toBe('a'.repeat(60))
  })

  it('allows a type name only on other, trimmed, 1 to 50 characters', () => {
    expect(typeLabelFor('mobile', undefined)).toBeNull()
    expect(typeLabelFor('mobile', '  ')).toBeNull()
    expect(codeOf(() => typeLabelFor('mobile', 'Cell'))).toBe('400 TYPE_LABEL_NOT_ALLOWED')
    expect(typeLabelFor('other', " Grandma's cell ")).toBe("Grandma's cell")
    expect(codeOf(() => typeLabelFor('other', null))).toBe('400 TYPE_LABEL_NOT_ALLOWED')
  })

  it('refuses a patch with nothing in it', () => {
    expect(codeOf(() => requireChange(false))).toBe('400 VALIDATION')
    expect(codeOf(() => requireChange(true))).toBeUndefined()
  })
})
