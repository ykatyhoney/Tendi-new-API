import { describe, expect, it } from 'vitest'
import { ApiError } from '../../src/lib/api-error.js'
import {
  assertOnePrimary,
  contactNames,
  legacyFullName,
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
