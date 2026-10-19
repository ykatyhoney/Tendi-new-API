// Comparison and likely-cause rules for the proof run (PLAN.md "Data backfill and proof of
// equivalence"). Pure functions: no database access.

import { normalizePhone } from '../lib/phone.ts';

export type Kind = 'phone' | 'string' | 'bit' | 'enum';
export type Value = string | number | null;

/**
 * The 28 mirrored legacy columns in mirror order, with how each is compared.
 * home_send_notification is not mirrored (it stays as stored), so it is not compared.
 */
export const COLUMNS: { name: string; table: 'children' | 'children_additional_information'; kind: Kind }[] = [
  { name: 'father_name', table: 'children', kind: 'string' },
  { name: 'mother_name', table: 'children', kind: 'string' },
  { name: 'father_phone', table: 'children', kind: 'phone' },
  { name: 'mother_phone', table: 'children', kind: 'phone' },
  { name: 'home_phone', table: 'children', kind: 'phone' },
  { name: 'parent_email', table: 'children', kind: 'string' },
  { name: 'use_father_phone_for_notification', table: 'children', kind: 'bit' },
  { name: 'use_mother_phone_for_notification', table: 'children', kind: 'bit' },
  { name: 'notification_father_phone_method', table: 'children', kind: 'enum' },
  { name: 'notification_mother_phone_method', table: 'children', kind: 'enum' },
  ...['father', 'mother'].flatMap((slot) => ([
    ['fname', 'string'], ['lname', 'string'], ['home_phone', 'phone'], ['email', 'string'], ['address', 'string'],
    ['occupation', 'string'], ['employer', 'string'], ['work_address', 'string'], ['office_phone', 'phone'],
  ] as const).map(([field, kind]) => ({ name: `${slot}_${field}`, table: 'children_additional_information' as const, kind }))),
];

/**
 * How two values relate, strictest first:
 * exact            identical (NULL = NULL)
 * null_vs_empty    one side NULL, the other ''
 * trim_casefold    equal after trimming, collapsing inner whitespace and lower-casing
 * phone_normalized different as typed, same normalized number (phones only)
 * different        none of the above
 */
export type Match = 'exact' | 'null_vs_empty' | 'trim_casefold' | 'phone_normalized' | 'different';

const fold = (v: Value) => String(v ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

export function compare(stored: Value, derived: Value, kind: Kind): Match {
  if (stored === derived) return 'exact';
  if (kind === 'bit' || kind === 'enum') return 'different';
  if ((stored === null && derived === '') || (stored === '' && derived === null)) return 'null_vs_empty';
  if (fold(stored) === fold(derived)) return 'trim_casefold';
  if (kind === 'phone') {
    const a = normalizePhone(String(stored ?? ''));
    if (a !== '' && a === normalizePhone(String(derived ?? ''))) return 'phone_normalized';
  }
  return 'different';
}

/** What the classifier knows about one child and the members the mirror picked for it. */
export interface ChildContext {
  hasCai: boolean;
  householdSize: number;
  /** Relationship of the member the mirror uses for each slot, or null if the slot is empty. */
  chosen: Record<'father' | 'mother', { memberId: number; relationship: string } | null>;
  /** The member holding this child's own rights row for each slot (created from its own data). */
  own: Record<'father' | 'mother', number | null>;
  hasPayer: boolean;
  householdPhone: string;
}

const slotOf = (column: string): 'father' | 'mother' | null =>
  /(^|_)father(_|$)/.test(column) ? 'father' : /(^|_)mother(_|$)/.test(column) ? 'mother' : null;

export const CAUSES = {
  missing_cai_row: 'Missing children_additional_information row (D4 creates it when linked)',
  null_vs_empty: 'NULL stored, empty string derived (or the reverse)',
  whitespace: 'Whitespace or letter case only',
  phone_format: 'Same phone number, typed differently',
  step_parent_slot: 'Step-parent fills the parent slot',
  shared_phone: "Household merged by a shared phone: a sibling's parent fills this child's slot",
  sibling_details: "Parent shared with siblings: the person's details come from the sibling with the lowest id",
  empty_slot_default: 'No parent in this slot: legacy holds the column default, the mirror gives NULL',
  sibling_household_phone: "Household merged by a shared phone: a sibling's home_phone became household_phone",
  payment_email_unmatched: 'parent_email matches neither parent\'s email, so nobody is payment-responsible',
  primary_email_fallback: 'Empty parent_email, but the primary member\'s email is used',
  household_phone_fallback: 'No phone labelled home: household_phone is used for *_home_phone',
  legacy_name_empty: 'Empty legacy name: built from fname and lname',
  legacy_null_notification: 'Legacy notification setting is NULL; a rights row always has a value',
  derivation_error: 'sp_family_preview raised an error',
  other: 'Other (unexplained)',
} as const;
export type Cause = keyof typeof CAUSES;

/**
 * The only causes accepted as explained ("filled exactly as today" otherwise). Any other cause
 * is a proof-run failure.
 */
export const ALLOWED_CAUSES: readonly Cause[] = ['missing_cai_row', 'payment_email_unmatched', 'sibling_details', 'shared_phone'];

export function classify(column: string, table: string, stored: Value, derived: Value, match: Match, ctx: ChildContext): Cause {
  if (table === 'children_additional_information' && !ctx.hasCai) return 'missing_cai_row';
  if (match === 'null_vs_empty') return 'null_vs_empty';
  if (match === 'trim_casefold') return 'whitespace';
  if (match === 'phone_normalized') return 'phone_format';

  const slot = slotOf(column);
  if (slot) {
    const chosen = ctx.chosen[slot];
    if (chosen?.relationship.startsWith('step_')) return 'step_parent_slot';
    if (ctx.householdSize > 1 && (chosen?.memberId ?? null) !== ctx.own[slot]) return 'shared_phone';
    if (ctx.householdSize > 1 && chosen !== null) return 'sibling_details';
    if (chosen === null && derived === null && stored !== null) return 'empty_slot_default';
  }
  if (column === 'home_phone' && ctx.householdSize > 1) return 'sibling_household_phone';
  if (column === 'parent_email') {
    if (String(stored ?? '') !== '' && !ctx.hasPayer) return 'payment_email_unmatched';
    if (String(stored ?? '') === '' && String(derived ?? '') !== '') return 'primary_email_fallback';
  }
  if (/_home_phone$/.test(column) && String(stored ?? '') === '' && derived === ctx.householdPhone) return 'household_phone_fallback';
  if (/_name$/.test(column) && String(stored ?? '') === '' && String(derived ?? '') !== '') return 'legacy_name_empty';
  if (/^(use_|notification_)/.test(column) && stored === null) return 'legacy_null_notification';
  return 'other';
}
