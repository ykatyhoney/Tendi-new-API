// The normalizePhone cases, shared by the unit test (test/family-backfill/plan.test.ts) and the DB
// test that runs them through families.household_phone_normalized (test/family-db/phone-normalization.test.ts),
// so the TypeScript and SQL rules are checked on the same inputs.

export interface PhoneCase {
  input: string | null;
  expected: string;
  rule: 'digits only, last 10' | 'an extension and everything after it is dropped' | 'fewer than 10 digits gives empty';
  note?: string;
}

export const PHONE_CASES: PhoneCase[] = [
  { input: '718-555-0199', expected: '7185550199', rule: 'digits only, last 10' },
  { input: '+1 (718) 555-0199', expected: '7185550199', rule: 'digits only, last 10' },
  { input: '718-555-0199 x12', expected: '7185550199', rule: 'an extension and everything after it is dropped' },
  { input: '718-555-0199x12', expected: '7185550199', rule: 'an extension and everything after it is dropped' },
  { input: '(718) 555-0199 ext 4455', expected: '7185550199', rule: 'an extension and everything after it is dropped' },
  { input: '718.555.0199 Ext. 7', expected: '7185550199', rule: 'an extension and everything after it is dropped' },
  { input: '718 555 0199 #301', expected: '7185550199', rule: 'an extension and everything after it is dropped' },
  {
    input: '+1 718 555 0199 X 2 (evenings)',
    expected: '7185550199',
    rule: 'an extension and everything after it is dropped',
  },
  { input: '555-0199', expected: '', rule: 'fewer than 10 digits gives empty' },
  {
    input: '555-0199 x1234',
    expected: '',
    rule: 'fewer than 10 digits gives empty',
    note: 'extension digits do not make up the missing digits',
  },
  { input: '000', expected: '', rule: 'fewer than 10 digits gives empty' },
  { input: null, expected: '', rule: 'fewer than 10 digits gives empty' },
];
