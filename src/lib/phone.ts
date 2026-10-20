// The schema's phone_normalized rule, shared by the Family API, the backfill and the tests.
//
// No normalizer exists elsewhere in this repository; the rule is taken from the data. The PHP app
// stores 10-digit values in parent_sms_messages.phone_normalized and matched '718-555-0199' and
// '7185550199' (children.father_phone) to the same 7185550199, which is "digits only, last 10".
// Unknown numbers are stored as '' there, so fewer than 10 digits gives ''.
// An extension ("x12", "ext 12", "ext. 12", "#12") and everything after it is dropped first,
// so its digits never shift the last 10.

const EXTENSION = /(?:ext\.?|x|#).*$/i;

/** The digits of a phone once any extension is dropped. */
export function phoneDigits(raw: string | null | undefined): string {
  return (raw ?? '').replace(EXTENSION, '').replace(/\D/g, '');
}

/** Drops any extension, then digits only, last 10; '' when fewer than 10 digits remain. */
export function normalizePhone(raw: string | null | undefined): string {
  const digits = phoneDigits(raw);
  return digits.length >= 10 ? digits.slice(-10) : '';
}
