// Unit tests for the backfill planner (no database): grouping rule D3, people dedupe, rights and
// the review reason codes.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { planBackfill } from '../../scripts/family/backfill/plan.ts';
import type { LegacyChild } from '../../scripts/family/backfill/plan.ts';
import { normalizePhone } from '../../scripts/family/lib/phone.ts';
import { PHONE_CASES } from '../support/phone-cases.ts';

function child(id: number, over: Partial<LegacyChild> = {}, cai: Record<string, string> = {}): LegacyChild {
  return {
    id, lname: 'Katz', father_name: '', mother_name: '', father_phone: '', mother_phone: '', home_phone: '',
    parent_email: '', use_father_phone_for_notification: 0, use_mother_phone_for_notification: 0,
    notification_father_phone_method: 'voice', notification_mother_phone_method: 'voice', has_cai: true,
    ...over, cai,
  };
}

const codes = (plan: ReturnType<typeof planBackfill>) => plan.review.map((r) => r.code).sort();

describe('normalizePhone', () => {
  for (const rule of new Set(PHONE_CASES.map((c) => c.rule))) {
    test(rule, () => {
      for (const c of PHONE_CASES.filter((x) => x.rule === rule)) {
        assert.equal(normalizePhone(c.input), c.expected, c.note ?? String(c.input));
      }
    });
  }
});

describe('planBackfill', () => {
  test('siblings sharing a father phone and surname form one household with one father', () => {
    const plan = planBackfill([
      child(1, { father_name: 'Yaakov Katz', father_phone: '718-555-0101' }, { father_fname: 'Yaakov', father_lname: 'Katz' }),
      child(2, { father_name: 'Yaakov Katz', father_phone: '(718) 555-0101' }, { father_fname: 'Yaakov', father_lname: 'Katz' }),
      child(3, { father_name: 'Other', father_phone: '718-555-0999' }),
    ]);
    assert.equal(plan.households.length, 2);
    const [h] = plan.households;
    assert.deepEqual(h.childIds, [1, 2]);
    assert.equal(h.name, 'Katz');
    assert.equal(h.people.length, 1, 'the father is deduplicated across siblings');
    assert.equal(h.people[0].phones[0].normalized, '7185550101');
    assert.equal(h.rights.length, 2);
    assert.deepEqual(codes(plan), ['MERGED_SIBLINGS']);
  });

  test('shared phone with a different surname: separate households, flagged', () => {
    const plan = planBackfill([
      child(1, { father_phone: '718-555-0101' }),
      child(2, { lname: 'Weiss', mother_phone: '7185550101' }),
    ]);
    assert.equal(plan.households.length, 2);
    assert.deepEqual(codes(plan), ['SHARED_PHONE_DIFFERENT_SURNAME']);
    assert.equal(plan.review[0].phone, '7185550101');
    assert.deepEqual(plan.review[0].householdRefs, [1, 2]);
  });

  test('a phone in more than 2 households is flagged', () => {
    const plan = planBackfill([
      child(1, { father_phone: '718-555-0101' }),
      child(2, { lname: 'Weiss', father_phone: '718-555-0101' }),
      child(3, { lname: 'Roth', father_phone: '718-555-0101' }),
    ]);
    assert.ok(codes(plan).includes('PHONE_IN_MANY_HOUSEHOLDS'));
  });

  test('children without a usable phone get their own household; short phones are flagged', () => {
    const plan = planBackfill([child(1, { father_phone: '000' }), child(2, { father_phone: '000' })]);
    assert.equal(plan.households.length, 2);
    assert.deepEqual(codes(plan), ['SHORT_PHONE', 'SHORT_PHONE']);
  });

  test('home phones group siblings only with --group-by-home-phone', () => {
    const kids = [child(1, {}, { father_home_phone: '(212) 555-0171' }), child(2, {}, { mother_home_phone: '212-555-0171' })];
    assert.equal(planBackfill(kids).households.length, 2);
    assert.equal(planBackfill(kids, { groupByHomePhone: true }).households.length, 1);
  });

  test('people get legacy name verbatim, CAI fields, labelled phones and addresses', () => {
    const plan = planBackfill([child(1, { father_name: '  Yakov Yitzchok ', father_phone: '347-555-0101' }, {
      father_fname: 'Yakov', father_lname: 'Wolpin', father_email: 'y@example.test', father_home_phone: '(212) 555-0171',
      father_office_phone: '(646) 555-0112', father_address: '8 Rena Lane', father_work_address: '1 Main St',
      father_occupation: 'Teacher', father_employer: 'School',
    })]);
    const [p] = plan.households[0].people;
    assert.equal(p.legacyFullName, '  Yakov Yitzchok ', 'kept verbatim');
    assert.deepEqual([p.fname, p.lname, p.email, p.occupation, p.employer], ['Yakov', 'Wolpin', 'y@example.test', 'Teacher', 'School']);
    assert.deepEqual(p.phones.map((ph) => [ph.label, ph.isPrimary, ph.phone]), [
      ['mobile', true, '347-555-0101'], ['home', false, '(212) 555-0171'], ['work', false, '(646) 555-0112'],
    ]);
    assert.deepEqual(p.addresses, [{ kind: 'home', line1: '8 Rena Lane' }, { kind: 'work', line1: '1 Main St' }]);
  });

  test('an empty legacy name is stored as empty, not built from fname/lname', () => {
    const plan = planBackfill([child(1, { father_name: '' }, { father_fname: 'Berl', father_lname: 'Berlin' })]);
    const [p] = plan.households[0].people;
    assert.equal(p.legacyFullName, '');
    assert.deepEqual([p.fname, p.lname], ['Berl', 'Berlin']);
  });

  test('rights copy the notification columns; the parent whose email is parent_email pays and is primary', () => {
    const plan = planBackfill([child(1, {
      father_name: 'F', mother_name: 'M', parent_email: 'M@example.test',
      use_father_phone_for_notification: 1, notification_father_phone_method: 'sms',
      use_mother_phone_for_notification: null, notification_mother_phone_method: null,
    }, { father_email: 'f@example.test', mother_email: 'm@example.test' })]);
    const [h] = plan.households;
    const [father, mother] = h.rights;
    assert.deepEqual([father.receivesNotifications, father.notifyMethod, father.isPaymentResponsible], [true, 'sms', false]);
    assert.deepEqual([mother.receivesNotifications, mother.notifyMethod, mother.isPaymentResponsible], [false, 'sms', true]);
    assert.deepEqual(h.people.map((p) => [p.slot, p.isPrimary, p.sortOrder]), [['father', false, 0], ['mother', true, 1]]);
  });

  test('nobody pays: no primary member; an unmatched parent_email is flagged', () => {
    const none = planBackfill([child(1, { father_name: 'F' }, { father_email: 'f@example.test' })]);
    assert.equal(none.households[0].people[0].isPrimary, false);
    const unmatched = planBackfill([child(1, { father_name: 'F', parent_email: 'x@example.test' }, { father_email: 'f@example.test' })]);
    assert.deepEqual(codes(unmatched), ['PAYMENT_EMAIL_UNMATCHED']);
  });

  test('sibling conflicts: different parent_email, different father, differing details', () => {
    const plan = planBackfill([
      child(1, { father_name: 'Avi', father_phone: '718-555-0101', parent_email: 'a@example.test', home_phone: '718-555-0001' },
        { father_email: 'a@example.test', father_address: '1 Elm' }),
      child(2, { father_name: 'Avi', father_phone: '718-555-0101', parent_email: 'b@example.test', home_phone: '718-555-0002' },
        { father_email: 'b@example.test', father_address: '2 Oak' }),
      child(3, { mother_phone: '718-555-0101' }),
    ]);
    assert.deepEqual(codes(plan), [
      'HOME_PHONE_CONFLICT', 'MERGED_SIBLINGS',
      'PARENT_DIFFERS_BETWEEN_SIBLINGS', 'PARENT_DIFFERS_BETWEEN_SIBLINGS', // father missing for child 3, mother only for child 3
      'PERSON_DETAILS_DIFFER', 'SIBLING_EMAIL_CONFLICT', 'SIBLING_EMAIL_CONFLICT',
    ]);
    assert.equal(plan.households.length, 1);
    assert.equal(plan.households[0].people.filter((p) => p.slot === 'father').length, 1, 'same phone + name: one father');
  });
});
