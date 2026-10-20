// Derivation rules of sp_family_mirror_values (PLAN.md "Legacy column mapping"), read through
// sp_family_preview for an unlinked child, plus the D4 insert on linking.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { useTestDatabase, value } from './support/db.ts';
import {
  addAddress, addMember, addPhone, createFamily, createPerson, emptyAs, link, pickChildren, preview, setRights, storedLegacy,
} from './support/family.ts';

const db = useTestDatabase();

describe('derivation', () => {
  test('both parents: all 28 values', async () => {
    const [child] = await pickChildren(db(), 1);
    const familyId = await createFamily(db(), { householdPhone: '718-555-0101' });
    const father = await createPerson(db(), {
      fname: 'Avraham', lname: 'Testman', legacyFullName: 'Avi Testman', email: 'avi@example.test',
      occupation: 'Accountant', employer: 'Acme Books',
    });
    const mother = await createPerson(db(), { fname: 'Sara', lname: 'Testman', email: 'sara@example.test' });
    await addPhone(db(), father, { phone: '(347) 555-0111', isPrimary: true });
    await addPhone(db(), father, { phone: '718-555-0112', label: 'home', sortOrder: 1 });
    await addPhone(db(), father, { phone: '212-555-0113', label: 'work', sortOrder: 2 });
    await addPhone(db(), mother, { phone: '347-555-0121', isPrimary: true });
    await addAddress(db(), father, { line1: '12 Fixture St', line2: 'Apt 4B', city: 'Brooklyn', state: 'NY', zip: '11211' });
    await addAddress(db(), father, { kind: 'work', line1: '1 Office Plaza', city: 'New York', state: 'NY', zip: '10001' });
    const fm = await addMember(db(), familyId, father, { relationship: 'father', isPrimary: true });
    const mm = await addMember(db(), familyId, mother, { relationship: 'mother', sortOrder: 1 });
    await setRights(db(), fm, child, { receivesNotifications: true, notifyMethod: 'sms' });
    await setRights(db(), mm, child, { notifyMethod: 'voice', isPaymentResponsible: true });
    const empty = await emptyAs(db(), child);

    assert.deepEqual(await preview(db(), child, familyId), {
      father_name: 'Avi Testman',
      mother_name: 'Sara Testman',
      father_phone: '(347) 555-0111',
      mother_phone: '347-555-0121',
      home_phone: '718-555-0101',
      parent_email: 'sara@example.test',
      use_father_phone_for_notification: 1,
      use_mother_phone_for_notification: 0,
      notification_father_phone_method: 'sms',
      notification_mother_phone_method: 'voice',
      father_fname: 'Avraham',
      father_lname: 'Testman',
      father_home_phone: '718-555-0112',
      father_email: 'avi@example.test',
      father_address: '12 Fixture St, Apt 4B, Brooklyn, NY 11211', // address format pending approval
      father_occupation: 'Accountant',
      father_employer: 'Acme Books',
      father_work_address: '1 Office Plaza, New York, NY 10001',
      father_office_phone: '212-555-0113',
      mother_fname: 'Sara',
      mother_lname: 'Testman',
      mother_home_phone: '718-555-0101', // no phone labelled home: falls back to the household phone
      mother_email: 'sara@example.test',
      // Empty values keep the child's legacy representation (NULL in older rows, '' otherwise).
      mother_address: empty.mother_address,
      mother_occupation: empty.mother_occupation,
      mother_employer: empty.mother_employer,
      mother_work_address: empty.mother_work_address,
      mother_office_phone: empty.mother_office_phone,
    });
  });

  test('an empty legacy name stays empty even when fname and lname are set', async () => {
    const [child] = await pickChildren(db(), 1);
    const familyId = await createFamily(db());
    const father = await createPerson(db(), { fname: 'Berl', lname: 'Berlin', legacyFullName: '' });
    await addMember(db(), familyId, father, { relationship: 'father' });
    const v = await preview(db(), child, familyId);
    assert.equal(v.father_name, '');
    assert.deepEqual([v.father_fname, v.father_lname], ['Berl', 'Berlin']);
  });

  test('empty CAI values: NULL where the stored value is NULL, \'\' otherwise', async () => {
    const [child] = await pickChildren(db(), 1);
    const familyId = await createFamily(db());
    const father = await createPerson(db(), { fname: 'Avi', lname: 'Test' });
    await addMember(db(), familyId, father, { relationship: 'father' });

    await db().query("UPDATE children_additional_information SET father_work_address = NULL, father_occupation = '' WHERE child_id = ?", [child]);
    let v = await preview(db(), child, familyId);
    assert.equal(v.father_work_address, null);
    assert.equal(v.father_occupation, '');

    await db().query("UPDATE children_additional_information SET father_work_address = '' WHERE child_id = ?", [child]);
    v = await preview(db(), child, familyId);
    assert.equal(v.father_work_address, '');

    await db().query("UPDATE children_additional_information SET father_work_address = '1 Old St' WHERE child_id = ?", [child]);
    v = await preview(db(), child, familyId);
    assert.equal(v.father_work_address, '', 'a value the family no longer has becomes \'\' (what the PHP app writes today)');
  });

  test('home_send_notification is not mirrored: the preview has 28 columns without it', async () => {
    const [child] = await pickChildren(db(), 1);
    const familyId = await createFamily(db());
    const v = await preview(db(), child, familyId);
    assert.equal(Object.keys(v).length, 28);
    assert.ok(!('home_send_notification' in v));
  });

  test('step-father only: fills the father slot; the mother slot stays empty', async () => {
    const [child] = await pickChildren(db(), 1);
    const familyId = await createFamily(db());
    const step = await createPerson(db(), { fname: 'Moshe', lname: 'Stepman', email: 'moshe@example.test' });
    const grandma = await createPerson(db(), { fname: 'Rivka', lname: 'Grand', email: 'rivka@example.test' });
    await addPhone(db(), step, { phone: '917-555-0201', isPrimary: true });
    const sm = await addMember(db(), familyId, step, { relationship: 'step_father', sortOrder: 1 });
    await addMember(db(), familyId, grandma, { relationship: 'grandmother', isPrimary: true });
    await setRights(db(), sm, child, { receivesNotifications: true, notifyMethod: 'both' });

    const v = await preview(db(), child, familyId);
    assert.equal(v.father_name, 'Moshe Stepman');
    assert.equal(v.father_phone, '917-555-0201');
    assert.equal(v.use_father_phone_for_notification, 1);
    assert.equal(v.notification_father_phone_method, 'both');
    assert.equal(v.father_fname, 'Moshe');
    assert.equal(v.mother_name, '');
    assert.equal(v.mother_phone, '');
    // Empty slot: the legacy values for "no notifications", not NULL.
    assert.equal(v.use_mother_phone_for_notification, 0);
    assert.equal(v.notification_mother_phone_method, 'voice');
    const empty = await emptyAs(db(), child);
    assert.equal(v.mother_fname, empty.mother_fname);
    assert.equal(v.mother_home_phone, empty.mother_home_phone);
    // Nobody is payment-responsible: the primary member's email.
    assert.equal(v.parent_email, 'rivka@example.test');
  });

  test('a father takes the slot even when a step-father has a lower sort_order', async () => {
    const [child] = await pickChildren(db(), 1);
    const familyId = await createFamily(db());
    const father = await createPerson(db(), { fname: 'Dovid', lname: 'Payer' });
    const step = await createPerson(db(), { fname: 'Extra', lname: 'Step' });
    await addMember(db(), familyId, step, { relationship: 'step_father', sortOrder: 0 });
    await addMember(db(), familyId, father, { relationship: 'father', sortOrder: 5 });
    assert.equal((await preview(db(), child, familyId)).father_name, 'Dovid Payer');
  });

  test('no mother: mother columns empty, a trashed mother is ignored', async () => {
    const [child] = await pickChildren(db(), 1);
    const familyId = await createFamily(db(), { householdPhone: '845-555-0301' });
    const father = await createPerson(db(), { fname: 'Yosef', lname: 'Solo', legacyFullName: 'Yossi Solo', email: 'yossi@example.test' });
    const mother = await createPerson(db(), { fname: 'Leah', lname: 'Solo', email: 'leah@example.test' });
    await addPhone(db(), father, { phone: '845-555-0311', isPrimary: true });
    await addMember(db(), familyId, father, { relationship: 'father', isPrimary: true });
    const mm = await addMember(db(), familyId, mother, { relationship: 'mother', status: 'trash' });
    await setRights(db(), mm, child, { receivesNotifications: true, isPaymentResponsible: true });

    const v = await preview(db(), child, familyId);
    assert.equal(v.father_name, 'Yossi Solo');
    assert.equal(v.mother_name, '');
    assert.equal(v.mother_phone, '');
    assert.equal(v.mother_email, (await emptyAs(db(), child)).mother_email);
    assert.equal(v.use_mother_phone_for_notification, 0);
    // The trashed mother's payment-responsible row is ignored: falls back to the primary member.
    assert.equal(v.parent_email, 'yossi@example.test');
  });

  test('two payment-responsible members: the lower family_members.sort_order wins, then the lower id', async () => {
    // Documented rule (SCHEMA.md): payment-responsible members are ordered by
    // family_members.sort_order, then family_members.id; is_primary does not break the tie.
    const [child] = await pickChildren(db(), 1);
    const familyId = await createFamily(db());
    const father = await createPerson(db(), { fname: 'Dovid', lname: 'Payer', email: 'dovid@example.test' });
    const mother = await createPerson(db(), { fname: 'Chana', lname: 'Payer', email: 'chana@example.test' });
    const fm = await addMember(db(), familyId, father, { relationship: 'father', isPrimary: true, sortOrder: 1 });
    const mm = await addMember(db(), familyId, mother, { relationship: 'mother', sortOrder: 0 });
    await setRights(db(), fm, child, { isPaymentResponsible: true });
    await setRights(db(), mm, child, { isPaymentResponsible: true });
    assert.equal((await preview(db(), child, familyId)).parent_email, 'chana@example.test');

    // Same sort_order: the member added first (lower id) wins.
    await db().query('UPDATE family_members SET sort_order = 0 WHERE id IN (?, ?)', [fm, mm]);
    assert.equal((await preview(db(), child, familyId)).parent_email, 'dovid@example.test');
  });

  test('person in two households: same person data, rights per child', async () => {
    const [childA, childB] = await pickChildren(db(), 2);
    const familyA = await createFamily(db(), { householdPhone: '718-555-0501' });
    const familyB = await createFamily(db(), { householdPhone: '718-555-0502' });
    const father = await createPerson(db(), { fname: 'Shared', lname: 'Father', email: 'shared@example.test' });
    await addPhone(db(), father, { phone: '917-555-0500', isPrimary: true });
    const inA = await addMember(db(), familyA, father, { relationship: 'father', isPrimary: true });
    const inB = await addMember(db(), familyB, father, { relationship: 'step_father', isPrimary: true });
    await setRights(db(), inA, childA, { receivesNotifications: true, notifyMethod: 'sms' });
    await setRights(db(), inB, childB, { receivesNotifications: false, notifyMethod: 'voice' });

    const a = await preview(db(), childA, familyA);
    const b = await preview(db(), childB, familyB);
    for (const v of [a, b]) {
      assert.equal(v.father_name, 'Shared Father');
      assert.equal(v.father_phone, '917-555-0500');
      assert.equal(v.parent_email, 'shared@example.test');
    }
    assert.deepEqual([a.home_phone, a.use_father_phone_for_notification, a.notification_father_phone_method], ['718-555-0501', 1, 'sms']);
    assert.deepEqual([b.home_phone, b.use_father_phone_for_notification, b.notification_father_phone_method], ['718-555-0502', 0, 'voice']);
  });

  test('parent with no primary phone: father_phone is empty, home phone falls back, office from work label', async () => {
    const [child] = await pickChildren(db(), 1);
    const familyId = await createFamily(db(), { householdPhone: '718-555-0601' });
    const father = await createPerson(db(), { fname: 'No', lname: 'Primary' });
    await addPhone(db(), father, { phone: '917-555-0611', isPrimary: false });
    await addPhone(db(), father, { phone: '212-555-0612', label: 'work', sortOrder: 1 });
    await addMember(db(), familyId, father, { relationship: 'father' });

    const v = await preview(db(), child, familyId);
    assert.equal(v.father_phone, '');
    assert.equal(v.father_home_phone, '718-555-0601');
    assert.equal(v.father_office_phone, '212-555-0612');
  });

  test('missing children_additional_information row: linking inserts it (D4)', async () => {
    const [child] = await pickChildren(db(), 1, { withCai: false, anyStatus: true });
    const familyId = await createFamily(db(), { householdPhone: '718-555-0701' });
    const mother = await createPerson(db(), { fname: 'Chana', lname: 'Insert', email: 'chana.i@example.test' });
    await addMember(db(), familyId, mother, { relationship: 'mother', isPrimary: true });
    await db().query('SET @audit_user = 4242');

    await link(db(), child, familyId);

    const stored = await storedLegacy(db(), child);
    assert.deepEqual(stored, await preview(db(), child));
    assert.equal(stored.mother_fname, 'Chana');
    assert.equal(stored.mother_home_phone, '718-555-0701');
    const createdBy = await value<number>(db(), 'SELECT created_by FROM children_additional_information WHERE child_id = ?', [child]);
    assert.equal(createdBy, 4242);
  });

  test('preview refuses an unlinked child without a family, and a trashed family', async () => {
    const [child] = await pickChildren(db(), 1);
    await assert.rejects(preview(db(), child), /not linked to a family/);
    const trashed = await createFamily(db(), { status: 'trash' });
    await assert.rejects(preview(db(), child, trashed), /does not exist or is not active/);
  });
});
