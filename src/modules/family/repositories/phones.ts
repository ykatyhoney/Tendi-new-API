/**
 * Equality on the generated column. EXPLAIN must use idx_fcp_norm.
 * Do not wrap phone_normalized in a function. Searches embed this statement as written.
 */
export const PHONE_LOOKUP_SQL =
  'SELECT p.family_contact_id AS familyContactId FROM family_contact_phones AS p WHERE p.phone_normalized = ?'
