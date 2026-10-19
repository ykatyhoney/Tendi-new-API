// Family edits made with plain SQL reach the linked children's 29 legacy columns through the
// trg_* triggers, inside the same (still open) transaction. Every test starts from two linked
// siblings whose household has a father and a mother (support/family.ts createParents).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { useTestDatabase } from './support/db.ts';
import type { Db } from './support/db.ts';
import {
  addAddress, addMember, addPhone, createParents, createPerson, link, pickChildren, preview, setRights, storedLegacy,
} from './support/family.ts';

const db = useTestDatabase();

async function linkedSiblings() {
  const children = await pickChildren(db(), 2);
  const family = await createParents(db(), children);
  for (const child of children) await link(db(), child, family.familyId);
  return { children, ...family };
}

/** Each child's stored 29 values equal what the mirror derives now; returns the stored values. */
async function assertMirrored(conn: Db, children: number[]) {
  const stored = [];
  for (const child of children) {
    const values = await storedLegacy(conn, child);
    assert.deepEqual(values, await preview(conn, child), `child ${child} is out of step with its family`);
    stored.push(values);
  }
  return stored;
}

async function inTransaction(conn: Db): Promise<boolean> {
  const [[row]] = await conn.query<any[]>('SELECT @@in_transaction AS t');
  return row.t === 1;
}

describe('propagation: families', () => {
  test('update household_phone reaches home_phone and the home-phone fallback of every sibling', async () => {
    const f = await linkedSiblings();
    await db().query('UPDATE families SET household_phone = ? WHERE id = ?', ['718-555-9999', f.familyId]);
    for (const v of await assertMirrored(db(), f.children)) {
      assert.equal(v.home_phone, '718-555-9999');
      assert.equal(v.father_home_phone, '718-555-9999');
      assert.equal(v.mother_home_phone, '718-555-9999');
    }
    assert.ok(await inTransaction(db()), 'the mirror must not commit');
  });

  test('delete is refused while children are linked (fk_children_family RESTRICT)', async () => {
    const f = await linkedSiblings();
    await assert.rejects(db().query('DELETE FROM families WHERE id = ?', [f.familyId]), /foreign key constraint fails/);
  });
});

describe('propagation: family_members', () => {
  test('insert: adding a step-mother to a household without a mother fills the mother slot', async () => {
    const f = await linkedSiblings();
    await db().query('DELETE FROM family_members WHERE id = ?', [f.motherMember]);
    const step = await createPerson(db(), { fname: 'Malka', lname: 'Step', email: 'malka@example.test' });
    await addPhone(db(), step, { phone: '917-555-0801', isPrimary: true });
    await addMember(db(), f.familyId, step, { relationship: 'step_mother', sortOrder: 2 });
    for (const v of await assertMirrored(db(), f.children)) {
      assert.equal(v.mother_name, 'Malka Step');
      assert.equal(v.mother_phone, '917-555-0801');
    }
  });

  test('update: changing the father to an uncle empties the father slot', async () => {
    const f = await linkedSiblings();
    await db().query("UPDATE family_members SET relationship = 'uncle' WHERE id = ?", [f.fatherMember]);
    for (const v of await assertMirrored(db(), f.children)) {
      assert.equal(v.father_name, '');
      assert.equal(v.father_phone, '');
      assert.equal(v.use_father_phone_for_notification, null, 'no father: no father notification flag');
    }
  });

  test('update: trashing the mother empties the mother slot', async () => {
    const f = await linkedSiblings();
    await db().query("UPDATE family_members SET status = 'trash' WHERE id = ?", [f.motherMember]);
    for (const v of await assertMirrored(db(), f.children)) {
      assert.equal(v.mother_name, '');
      assert.equal(v.use_mother_phone_for_notification, null);
      assert.equal(v.parent_email, 'avi@example.test', 'falls back to the primary member');
    }
  });

  test('delete: removing the mother (and, by cascade, her rights) empties the mother slot', async () => {
    const f = await linkedSiblings();
    await db().query('DELETE FROM family_members WHERE id = ?', [f.motherMember]);
    for (const v of await assertMirrored(db(), f.children)) {
      assert.equal(v.mother_name, '');
      assert.equal(v.mother_fname, '');
      assert.equal(v.notification_mother_phone_method, null);
    }
  });
});

describe('propagation: people', () => {
  test('update: name and email reach every sibling', async () => {
    const f = await linkedSiblings();
    await db().query("UPDATE people SET fname = 'Sarah', email = 'sarah.new@example.test' WHERE id = ?", [f.motherId]);
    for (const v of await assertMirrored(db(), f.children)) {
      assert.equal(v.mother_name, 'Sarah Test');
      assert.equal(v.mother_fname, 'Sarah');
      assert.equal(v.mother_email, 'sarah.new@example.test');
      assert.equal(v.parent_email, 'sarah.new@example.test');
    }
  });

  test('update: trashing a person empties their slot', async () => {
    const f = await linkedSiblings();
    await db().query("UPDATE people SET status = 'trash' WHERE id = ?", [f.fatherId]);
    for (const v of await assertMirrored(db(), f.children)) assert.equal(v.father_name, '');
  });

  test('insert has no effect until the person joins a household', async () => {
    const f = await linkedSiblings();
    const before = await assertMirrored(db(), f.children);
    await createPerson(db(), { fname: 'Not', lname: 'Member' });
    assert.deepEqual(await assertMirrored(db(), f.children), before);
  });

  test('delete is refused while the person is a household member (fk_fm_person RESTRICT)', async () => {
    const f = await linkedSiblings();
    await assert.rejects(db().query('DELETE FROM people WHERE id = ?', [f.fatherId]), /foreign key constraint fails/);
  });
});

describe('propagation: people_phones', () => {
  test('insert: a home-labelled phone becomes *_home_phone', async () => {
    const f = await linkedSiblings();
    await addPhone(db(), f.fatherId, { phone: '718-555-0901', label: 'home', sortOrder: 1 });
    for (const v of await assertMirrored(db(), f.children)) assert.equal(v.father_home_phone, '718-555-0901');
  });

  test('update: changing the primary phone', async () => {
    const f = await linkedSiblings();
    await db().query("UPDATE people_phones SET phone = '347-555-0999' WHERE person_id = ? AND is_primary = 1", [f.fatherId]);
    for (const v of await assertMirrored(db(), f.children)) assert.equal(v.father_phone, '347-555-0999');
  });

  test('delete: removing the only phone empties father_phone', async () => {
    const f = await linkedSiblings();
    await db().query('DELETE FROM people_phones WHERE person_id = ?', [f.fatherId]);
    for (const v of await assertMirrored(db(), f.children)) assert.equal(v.father_phone, '');
  });
});

describe('propagation: people_addresses', () => {
  test('insert, update and delete of a home address', async () => {
    const f = await linkedSiblings();
    const address = await addAddress(db(), f.motherId, { line1: '5 Elm St', city: 'Monsey', state: 'NY', zip: '10952' });
    for (const v of await assertMirrored(db(), f.children)) assert.equal(v.mother_address, '5 Elm St, Monsey, NY 10952');

    await db().query("UPDATE people_addresses SET line1 = '7 Oak St' WHERE id = ?", [address]);
    for (const v of await assertMirrored(db(), f.children)) assert.equal(v.mother_address, '7 Oak St, Monsey, NY 10952');

    await db().query('DELETE FROM people_addresses WHERE id = ?', [address]);
    for (const v of await assertMirrored(db(), f.children)) assert.equal(v.mother_address, '');
  });

  test('a work address becomes *_work_address', async () => {
    const f = await linkedSiblings();
    await addAddress(db(), f.fatherId, { kind: 'work', line1: '1 Office Plaza', city: 'New York', state: 'NY' });
    for (const v of await assertMirrored(db(), f.children)) assert.equal(v.father_work_address, '1 Office Plaza, New York, NY');
  });
});

describe('propagation: family_member_children', () => {
  test('insert, update and delete of a rights row affect only that child', async () => {
    const f = await linkedSiblings();
    const [first, second] = f.children;
    const uncle = await createPerson(db(), { fname: 'Uncle', lname: 'Pays', email: 'uncle@example.test' });
    const um = await addMember(db(), f.familyId, uncle, { relationship: 'uncle', sortOrder: -1 });

    const rights = await setRights(db(), um, first, { isPaymentResponsible: true });
    const [a, b] = await assertMirrored(db(), f.children);
    assert.equal(a.parent_email, 'uncle@example.test', 'lower sort_order payer wins for the first child');
    assert.equal(b.parent_email, 'sara@example.test', 'the second child is unaffected');

    await db().query("UPDATE family_member_children SET notify_method = 'both', receives_notifications = 0 WHERE member_id = ? AND child_id = ?",
      [f.fatherMember, second]);
    const [, b2] = await assertMirrored(db(), f.children);
    assert.equal(b2.notification_father_phone_method, 'both');
    assert.equal(b2.use_father_phone_for_notification, 0);

    await db().query('DELETE FROM family_member_children WHERE id = ?', [rights]);
    const [a3] = await assertMirrored(db(), f.children);
    assert.equal(a3.parent_email, 'sara@example.test');
  });

  test('deleting the father\'s rights row sets his notification columns to NULL', async () => {
    const f = await linkedSiblings();
    await db().query('DELETE FROM family_member_children WHERE member_id = ? AND child_id = ?', [f.fatherMember, f.children[0]]);
    const [a] = await assertMirrored(db(), f.children);
    assert.equal(a.use_father_phone_for_notification, null);
    assert.equal(a.notification_father_phone_method, null);
  });
});
