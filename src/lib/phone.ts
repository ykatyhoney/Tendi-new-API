const EXTENSION = /(?:ext\.?|x|#).*$/i

/** Digits of a phone after the extension marker is removed. Matches the stored phone expression. */
export function digitsOf(value: string): string {
  return value.replace(EXTENSION, '').replace(/\D/g, '')
}

/**
 * Search key for a phone query. Seven or more digits become the last ten.
 * Shorter queries are names, not phones.
 */
export function phoneSearchKey(query: string): string | null {
  const digits = digitsOf(query)
  if (digits.length < 7) {
    return null
  }
  return digits.slice(-10)
}

/**
 * Same expression as family_contact_phones.phone_normalized, for a trusted column.
 * The column text is chosen by this code, never by a request.
 */
export function normalizedPhoneSql(column: string): string {
  const digits = digitSql(column)
  return `CASE WHEN CHAR_LENGTH(${digits}) >= 10 THEN RIGHT(${digits}, 10) ELSE '' END`
}

function digitSql(column: string): string {
  return `REGEXP_REPLACE(REGEXP_REPLACE(${column}, '(?i)(ext\\\\.?|x|#).*$', ''), '[^0-9]', '')`
}
