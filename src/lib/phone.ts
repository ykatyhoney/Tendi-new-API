import { quoteIdentifier } from './sql.js'

const EXTENSION = /(?:ext\.?|x|#).*$/i

/** Digits of a phone after the extension marker is removed. Matches the stored phone expression. */
export function digitsOf(value: string): string {
  return value.replace(EXTENSION, '').replace(/\D/g, '')
}

/** The value family_contact_phones.phone_normalized holds for this phone: the last ten digits, or ''. */
export function normalizedPhone(value: string): string {
  const digits = digitsOf(value)
  return digits.length >= 10 ? digits.slice(-10) : ''
}

/**
 * How a search query is matched against phones. phone_normalized is '' or exactly ten digits, so:
 * - ten or more digits: the last ten, an exact match (uses idx_fcp_norm);
 * - seven to nine digits: a suffix of the normalized phone;
 * - fewer than seven: not a phone search (the query is a name).
 */
export interface PhoneSearch {
  kind: 'exact' | 'suffix'
  digits: string
}

export function phoneSearch(query: string): PhoneSearch | null {
  const digits = digitsOf(query)
  if (digits.length >= 10) {
    return { kind: 'exact', digits: digits.slice(-10) }
  }
  if (digits.length >= 7) {
    return { kind: 'suffix', digits }
  }
  return null
}

/** The placeholder value for a phone search: the digits, or a LIKE suffix pattern. Digits need no escaping. */
export function phoneSearchParam(search: PhoneSearch): string {
  return search.kind === 'exact' ? search.digits : `%${search.digits}`
}

/**
 * Same expression as family_contact_phones.phone_normalized, for a trusted column.
 * The column text is chosen by this code, never by a request.
 */
export function normalizedPhoneSql(column: string): string {
  const quoted = column.split('.').map((part) => quoteIdentifier(part)).join('.')
  const digits = digitSql(quoted)
  return `CASE WHEN CHAR_LENGTH(${digits}) >= 10 THEN RIGHT(${digits}, 10) ELSE '' END`
}

function digitSql(column: string): string {
  return `REGEXP_REPLACE(REGEXP_REPLACE(${column}, '(?i)(ext\\\\.?|x|#).*$', ''), '[^0-9]', '')`
}
