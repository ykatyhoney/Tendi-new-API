// Business rules JSON Schema cannot express (src/modules/family/service/validation.ts) and the
// server-side phone normalization (service/phones.ts). No database.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { preparePhones } from '../../src/modules/family/service/phones.ts';
import {
  charLength,
  checkAddMember,
  checkAddresses,
  checkEmail,
  checkHouseholdPhone,
  checkPhones,
  checkRights,
  defaultLegacyName,
  formatAddress,
} from '../../src/modules/family/service/validation.ts';

const rejects400 = (fn: () => void, pattern: RegExp) =>
  assert.throws(fn, (e: Error & { statusCode?: number }) => e.statusCode === 400 && pattern.test(e.message));

describe('family request rules', () => {
  test('phones: exactly one primary when any exist', () => {
    checkPhones([]);
    checkPhones([{ phone: '718-555-0101', label: 'mobile', is_primary: true }]);
    rejects400(
      () => checkPhones([{ phone: '718-555-0101', label: 'mobile', is_primary: false }]),
      /exactly one.*found 0/,
    );
    rejects400(
      () =>
        checkPhones([
          { phone: '718-555-0101', label: 'mobile', is_primary: true },
          { phone: '718-555-0102', label: 'home', is_primary: true },
        ]),
      /found 2/,
    );
  });

  test('phones: home and work phones fit the 30-character legacy columns', () => {
    const long = '718-555-0101 ext 1234 (evenings only)';
    checkPhones([{ phone: long, label: 'mobile', is_primary: true }]);
    rejects400(
      () =>
        checkPhones([
          { phone: '1', label: 'mobile', is_primary: true },
          { phone: long, label: 'work' },
        ]),
      /phones\/1\/phone.*30/,
    );
  });

  test('rights: collect_to on or after collect_from; each member once', () => {
    checkRights([{ member_id: 1, collect_from: '2026-09-01', collect_to: '2026-09-01' }]);
    checkRights([{ member_id: 1, collect_from: '2026-09-01', collect_to: null }]);
    rejects400(
      () => checkRights([{ member_id: 1, collect_from: '2026-09-02', collect_to: '2026-09-01' }]),
      /rights\/0\/collect_to.*on or after/,
    );
    rejects400(() => checkRights([{ member_id: 1 }, { member_id: 1 }]), /more than once/);
  });

  test('add member: exactly one of person_id or person; email fits the 150-character legacy column', () => {
    checkAddMember({ person_id: 5 });
    checkAddMember({ person: { email: 'a@example.test' } });
    rejects400(() => checkAddMember({}), /exactly one of person_id/);
    rejects400(() => checkAddMember({ person_id: 5, person: {} }), /exactly one of person_id/);
    rejects400(() => checkEmail(`${'a'.repeat(140)}@example.test`), /varchar\(150\)/);
  });

  test('addresses: home and work addresses fit the 255-character legacy columns once formatted', () => {
    const a = { kind: 'home', line1: '12 Main St', line2: 'Apt 4B', city: 'Brooklyn', state: 'NY', zip: '11211' };
    assert.equal(formatAddress(a), '12 Main St, Apt 4B, Brooklyn, NY 11211');
    checkAddresses([a, { ...a, kind: 'billing', line1: 'x'.repeat(255), line2: 'y'.repeat(100) }]);
    rejects400(() => checkAddresses([{ ...a, line1: 'x'.repeat(200), line2: 'y'.repeat(100) }]), /formatted address/);
  });

  test('household_phone fits the 30-character legacy home phone it falls back to', () => {
    checkHouseholdPhone('718-555-0101');
    checkHouseholdPhone(undefined);
    rejects400(() => checkHouseholdPhone('x'.repeat(31)), /household_phone.*30/);
  });

  test("a new person's legacy name (always fname lname) fits the 100-character legacy name", () => {
    assert.equal(defaultLegacyName({ fname: ' Avi ', lname: 'Test' }), 'Avi Test');
    assert.equal(defaultLegacyName({ fname: '', lname: 'Test' }), 'Test');
    checkAddMember({ person: { fname: 'a'.repeat(50), lname: 'b'.repeat(49) } });
    rejects400(() => checkAddMember({ person: { fname: 'a'.repeat(50), lname: 'b'.repeat(50) } }), /varchar\(100\)/);
  });

  test('lengths are counted in characters (code points), like MariaDB and Ajv', () => {
    assert.equal(charLength('😀'.repeat(30)), 30);
    checkHouseholdPhone('😀'.repeat(30));
  });

  test('phone_normalized is computed server-side with the shared normalizer', () => {
    assert.deepEqual(
      preparePhones([
        { phone: '+1 (718) 555-0199 x12', label: 'mobile', channel: 'sms', is_primary: true },
        { phone: '555-0199', label: 'home', channel: 'none', is_primary: false, sort_order: 7 },
      ]),
      [
        {
          phone: '+1 (718) 555-0199 x12',
          phone_normalized: '7185550199',
          label: 'mobile',
          channel: 'sms',
          is_primary: true,
          sort_order: 0,
        },
        { phone: '555-0199', phone_normalized: '', label: 'home', channel: 'none', is_primary: false, sort_order: 7 },
      ],
    );
  });
});
