import { phoneSearchParam, type PhoneSearch } from '../../../lib/phone.js'

/**
 * Equality on the generated column. EXPLAIN must use idx_fcp_norm.
 * Do not wrap phone_normalized in a function. Searches embed this statement as written.
 */
export const PHONE_LOOKUP_SQL =
  'SELECT p.family_contact_id AS familyContactId FROM family_contact_phones AS p WHERE p.phone_normalized = ?'

/** A 7 to 9 digit search: a suffix of the normalized phone. A leading-wildcard LIKE cannot seek the index. */
export const PHONE_SUFFIX_SQL =
  'SELECT p.family_contact_id AS familyContactId FROM family_contact_phones AS p WHERE p.phone_normalized LIKE ?'

/** Contact ids whose phone matches the search, with the placeholder value. */
export function phoneLookup(search: PhoneSearch): { sql: string; params: string[] } {
  return {
    sql: search.kind === 'exact' ? PHONE_LOOKUP_SQL : PHONE_SUFFIX_SQL,
    params: [phoneSearchParam(search)],
  }
}
