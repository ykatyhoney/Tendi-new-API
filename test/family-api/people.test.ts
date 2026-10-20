// PATCH /people/:id, PUT /people/:id/phones, PUT /people/:id/addresses: happy path, validation
// (400) and unknown person (404). Each test is rolled back.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { NO_ID, newFamily, newMember, useApi } from './support/api.ts';

const api = useApi();

async function person() {
  return (await newMember(api, await newFamily(api, 'People'), 'Avi', 'father')).person_id;
}

describe('GET /people/:id', () => {
  test('200: the person with phones, addresses and every household, by family name', async () => {
    const zeta = await newFamily(api, 'Zeta household', '718-555-0111');
    const alpha = await newFamily(api, 'Alpha household', '');
    const m = await newMember(api, zeta, 'Avi', 'father', { phone: '347-555-0101', is_primary: true });
    const uncle = await api.ok(
      'POST',
      `/families/${alpha}/members`,
      { person_id: m.person_id, relationship: 'uncle' },
      201,
    );
    await api.ok('PUT', `/people/${m.person_id}/addresses`, { addresses: [{ kind: 'home', line1: '12 Elm St' }] });

    const p = await api.ok('GET', `/people/${m.person_id}`);
    assert.deepEqual([p.id, p.fname, p.legacy_full_name, p.status], [m.person_id, 'Avi', 'Avi Testerman', 'active']);
    assert.deepEqual(
      p.phones.map((x: { phone: string; is_primary: boolean }) => [x.phone, x.is_primary]),
      [['347-555-0101', true]],
    );
    assert.deepEqual(
      p.addresses.map((x: { line1: string }) => x.line1),
      ['12 Elm St'],
    );
    assert.deepEqual(p.households, [
      {
        member_id: uncle.id,
        family_id: alpha,
        family_name: 'Alpha household',
        household_phone: '',
        relationship: 'uncle',
        is_primary: false,
      },
      {
        member_id: m.id,
        family_id: zeta,
        family_name: 'Zeta household',
        household_phone: '718-555-0111',
        relationship: 'father',
        is_primary: true,
      },
    ]);
  });

  test('a removed membership and a trashed family are not listed', async () => {
    const kept = await newFamily(api, 'Kept');
    const left = await newFamily(api, 'Left');
    const gone = await newFamily(api, 'Gone');
    const m = await newMember(api, kept, 'Avi', 'father');
    const leftMember = await api.ok(
      'POST',
      `/families/${left}/members`,
      { person_id: m.person_id, relationship: 'uncle' },
      201,
    );
    await api.ok('POST', `/families/${gone}/members`, { person_id: m.person_id, relationship: 'uncle' }, 201);
    await api.ok('DELETE', `/families/${left}/members/${leftMember.id}`);
    await api.db().query("UPDATE families SET status = 'trash' WHERE id = ?", [gone]);
    const p = await api.ok('GET', `/people/${m.person_id}`);
    assert.deepEqual(
      p.households.map((h: { family_id: number }) => h.family_id),
      [kept],
    );
  });

  test('404 for an unknown or trashed person; 400 for a bad id', async () => {
    assert.equal(await api.fails('GET', `/people/${NO_ID}`, 404), `Person ${NO_ID} not found`);
    const id = await person();
    await api.db().query("UPDATE people SET status = 'trash' WHERE id = ?", [id]);
    assert.equal(await api.fails('GET', `/people/${id}`, 404), `Person ${id} not found`);
    assert.equal((await api.request('GET', '/people/abc')).statusCode, 400);
  });
});

describe('PATCH /people/:id', () => {
  test('200; a changed fname also sets legacy_full_name', async () => {
    const id = await person();
    const p = await api.ok('PATCH', `/people/${id}`, { fname: 'Avraham', note: 'prefers sms', hebrew_name: 'אברהם' });
    assert.deepEqual(
      [p.fname, p.legacy_full_name, p.note, p.hebrew_name, p.warning],
      ['Avraham', 'Avraham Testerman', 'prefers sms', 'אברהם', undefined],
    );
  });

  test('400: an empty body, legacy_full_name sent, an email over 150, a legacy name over 100', async () => {
    const id = await person();
    assert.equal((await api.request('PATCH', `/people/${id}`, {})).statusCode, 400);
    assert.match(await api.fails('PATCH', `/people/${id}`, 400, { legacy_full_name: 'X' }), /additional properties/);
    assert.match(await api.fails('PATCH', `/people/${id}`, 400, { email: `${'a'.repeat(150)}@x.test` }), /email/);
    assert.match(await api.fails('PATCH', `/people/${id}`, 400, { fname: 'D'.repeat(100) }), /legacy_full_name/);
  });

  test('404 for an unknown person', async () => {
    assert.equal(await api.fails('PATCH', `/people/${NO_ID}`, 404, { fname: 'A' }), `Person ${NO_ID} not found`);
  });
});

describe('PUT /people/:id/phones', () => {
  test('200 with the list, phone_normalized computed; an empty list clears it', async () => {
    const id = await person();
    const res = await api.ok('PUT', `/people/${id}/phones`, {
      phones: [
        { phone: '(718) 555-0123 x4', label: 'mobile', is_primary: true },
        { phone: '718.555.0124', label: 'home', channel: 'voice' },
      ],
    });
    assert.deepEqual(
      res.phones.map((p: Record<string, unknown>) => [
        p.phone,
        p.phone_normalized,
        p.label,
        p.channel,
        p.is_primary,
        p.sort_order,
      ]),
      [
        ['(718) 555-0123 x4', '7185550123', 'mobile', 'sms', true, 0],
        ['718.555.0124', '7185550124', 'home', 'voice', false, 1],
      ],
    );
    assert.deepEqual((await api.ok('PUT', `/people/${id}/phones`, { phones: [] })).phones, []);
  });

  test('400: no or two primary phones, phone_normalized sent, an unknown label, a home phone over 30', async () => {
    const id = await person();
    const url = `/people/${id}/phones`;
    assert.match(await api.fails('PUT', url, 400, { phones: [{ phone: '1', label: 'mobile' }] }), /exactly one phone/);
    assert.match(
      await api.fails('PUT', url, 400, {
        phones: [
          { phone: '1', label: 'mobile', is_primary: true },
          { phone: '2', label: 'mobile', is_primary: true },
        ],
      }),
      /found 2/,
    );
    assert.equal(
      (
        await api.request('PUT', url, {
          phones: [{ phone: '1', label: 'mobile', is_primary: true, phone_normalized: '1' }],
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (await api.request('PUT', url, { phones: [{ phone: '1', label: 'pager', is_primary: true }] })).statusCode,
      400,
    );
    assert.match(
      await api.fails('PUT', url, 400, { phones: [{ phone: '7'.repeat(31), label: 'home', is_primary: true }] }),
      /at most 30/,
    );
  });

  test('404 for an unknown person', async () => {
    assert.equal(await api.fails('PUT', `/people/${NO_ID}/phones`, 404, { phones: [] }), `Person ${NO_ID} not found`);
  });
});

describe('PUT /people/:id/addresses', () => {
  test('200 with the list, missing parts as ""', async () => {
    const id = await person();
    const res = await api.ok('PUT', `/people/${id}/addresses`, {
      addresses: [{ kind: 'home', line1: '12 Elm St', city: 'Monsey', state: 'NY', zip: '10952' }, { kind: 'billing' }],
    });
    assert.deepEqual(
      res.addresses.map((a: Record<string, unknown>) => [a.kind, a.line1, a.line2, a.city]),
      [
        ['home', '12 Elm St', '', 'Monsey'],
        ['billing', '', '', ''],
      ],
    );
  });

  test('400: an unknown kind, a mirrored address over 255 characters formatted', async () => {
    const id = await person();
    const url = `/people/${id}/addresses`;
    assert.equal((await api.request('PUT', url, { addresses: [{ kind: 'vacation' }] })).statusCode, 400);
    assert.match(
      await api.fails('PUT', url, 400, {
        addresses: [{ kind: 'home', line1: 'a'.repeat(200), line2: 'b'.repeat(100) }],
      }),
      /too long/,
    );
    // A billing address is not mirrored, so the same length is fine.
    await api.ok('PUT', url, { addresses: [{ kind: 'billing', line1: 'a'.repeat(200), line2: 'b'.repeat(100) }] });
  });

  test('404 for an unknown person', async () => {
    assert.equal(
      await api.fails('PUT', `/people/${NO_ID}/addresses`, 404, { addresses: [] }),
      `Person ${NO_ID} not found`,
    );
  });
});
