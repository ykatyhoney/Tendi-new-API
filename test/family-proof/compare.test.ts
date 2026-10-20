// Unit tests for the proof-run comparison levels and likely-cause rules (no database).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { COLUMNS, classify, compare } from '../../scripts/family/proof/compare.ts';
import type { ChildContext } from '../../scripts/family/proof/compare.ts';

const ctx = (over: Partial<ChildContext> = {}): ChildContext => ({
  hasCai: true, householdSize: 1, chosen: { father: { memberId: 1, relationship: 'father' }, mother: null },
  own: { father: 1, mother: null }, hasPayer: true, householdPhone: '', ...over,
});

describe('compare', () => {
  test('exact, NULL vs empty, whitespace/case, phone format, different', () => {
    assert.equal(compare('Avi', 'Avi', 'string'), 'exact');
    assert.equal(compare(null, null, 'string'), 'exact');
    assert.equal(compare(null, '', 'string'), 'null_vs_empty');
    assert.equal(compare(' Avi  Test', 'avi test', 'string'), 'trim_casefold');
    assert.equal(compare('(718) 555-0199', '718-555-0199', 'phone'), 'phone_normalized');
    assert.equal(compare('718-555-0199 x2', '7185550199', 'phone'), 'phone_normalized');
    assert.equal(compare('718-555-0199', '718-555-0198', 'phone'), 'different');
    assert.equal(compare('(718) 555-0199', '718-555-0199', 'string'), 'different', 'only phones are normalized');
  });

  test('bit and enum by value only', () => {
    assert.equal(compare(1, 1, 'bit'), 'exact');
    assert.equal(compare(0, null, 'bit'), 'different');
    assert.equal(compare('voice', 'VOICE', 'enum'), 'different');
  });
});

describe('classify', () => {
  test('format-level causes come first', () => {
    assert.equal(classify('father_email', 'children_additional_information', null, '', 'null_vs_empty', ctx({ hasCai: false })), 'missing_cai_row');
    assert.equal(classify('father_work_address', 'children_additional_information', null, '', 'null_vs_empty', ctx()), 'null_vs_empty');
    assert.equal(classify('father_name', 'children', 'Avi ', 'Avi', 'trim_casefold', ctx()), 'whitespace');
  });

  test('slot causes: step-parent, sibling parent, sibling details, empty slot default', () => {
    const step = ctx({ chosen: { father: { memberId: 2, relationship: 'step_father' }, mother: null } });
    assert.equal(classify('father_name', 'children', 'A', 'B', 'different', step), 'step_parent_slot');
    const merged = ctx({ householdSize: 3, chosen: { father: { memberId: 2, relationship: 'father' }, mother: null }, own: { father: 1, mother: null } });
    assert.equal(classify('father_phone', 'children', '1', '2', 'different', merged), 'shared_phone');
    const deduped = ctx({ householdSize: 3 });
    assert.equal(classify('father_home_phone', 'children_additional_information', '', '212-555-0197', 'different', deduped), 'sibling_details');
    const empty = ctx({ chosen: { father: null, mother: null }, own: { father: null, mother: null } });
    assert.equal(classify('notification_father_phone_method', 'children', 'voice', null, 'different', empty), 'empty_slot_default');
  });

  test('parent_email, names and the household phone fallback', () => {
    assert.equal(classify('parent_email', 'children', 'x@example.test', '', 'different', ctx({ hasPayer: false })), 'payment_email_unmatched');
    assert.equal(classify('parent_email', 'children', '', 'p@example.test', 'different', ctx()), 'primary_email_fallback');
    assert.equal(classify('mother_name', 'children', '', 'Vajda', 'different', ctx()), 'legacy_name_empty');
    assert.equal(classify('father_home_phone', 'children_additional_information', '', '718-555-0101', 'different',
      ctx({ householdPhone: '718-555-0101' })), 'household_phone_fallback');
  });

  test('home_send_notification is not a compared column', () => {
    assert.equal(COLUMNS.length, 28);
    assert.ok(!COLUMNS.some((c) => c.name === 'home_send_notification'));
  });
});
