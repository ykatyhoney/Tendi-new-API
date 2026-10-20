// POST /families/:id/members, PATCH and DELETE /families/:id/members/:memberId: happy path,
// validation (400), 404, and the duplicate member (409). Each test is rolled back.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { NO_ID, newFamily, newMember, useApi } from './support/api.ts';

const api = useApi();

describe('POST /families/:id/members', () => {
  test('201 for a new person and for an existing one; the person is shared', async () => {
    const first = await newFamily(api, 'First');
    const second = await newFamily(api, 'Second');
    const m = await api.ok(
      'POST',
      `/families/${first}/members`,
      { person: { fname: 'Avi', lname: 'Katz', email: 'avi@example.test' }, relationship: 'father', is_primary: true },
      201,
    );
    assert.deepEqual(
      [m.family_id, m.relationship, m.is_primary, m.status, m.person.legacy_full_name, m.person.email],
      [first, 'father', true, 'active', 'Avi Katz', 'avi@example.test'],
    );
    const again = await api.ok(
      'POST',
      `/families/${second}/members`,
      { person_id: m.person_id, relationship: 'uncle' },
      201,
    );
    assert.deepEqual([again.family_id, again.person_id, again.relationship], [second, m.person_id, 'uncle']);
  });

  test('409 for a person who is already an active member; 200 bringing back a removed one', async () => {
    const id = await newFamily(api, 'Dup');
    const m = await newMember(api, id, 'Avi', 'father');
    assert.equal(
      await api.fails('POST', `/families/${id}/members`, 409, { person_id: m.person_id, relationship: 'father' }),
      `Person ${m.person_id} is already a member of family ${id} (member ${m.id})`,
    );
    await api.ok('DELETE', `/families/${id}/members/${m.id}`);
    const back = await api.ok('POST', `/families/${id}/members`, {
      person_id: m.person_id,
      relationship: 'step_father',
    });
    assert.deepEqual([back.id, back.status, back.relationship], [m.id, 'active', 'step_father']);
  });

  test('400: both or neither of person_id and person, an unknown relationship, a long name or email', async () => {
    const id = await newFamily(api, 'Invalid');
    const url = `/families/${id}/members`;
    const m = await newMember(api, id, 'Avi', 'father');
    assert.match(
      await api.fails('POST', url, 400, { person_id: m.person_id, person: { fname: 'X' }, relationship: 'aunt' }),
      /exactly one of person_id/,
    );
    assert.match(await api.fails('POST', url, 400, { relationship: 'aunt' }), /exactly one of person_id/);
    assert.equal(
      (await api.request('POST', url, { person: { fname: 'X' }, relationship: 'neighbour' })).statusCode,
      400,
    );
    assert.equal((await api.request('POST', url, { person: { fname: 'X' } })).statusCode, 400);
    assert.match(
      await api.fails('POST', url, 400, {
        person: { fname: 'A'.repeat(60), lname: 'B'.repeat(60) },
        relationship: 'aunt',
      }),
      /legacy_full_name/,
    );
    assert.match(
      await api.fails('POST', url, 400, { person: { email: `${'a'.repeat(150)}@x.test` }, relationship: 'aunt' }),
      /email/,
    );
  });

  test('404 for an unknown family or person_id', async () => {
    const id = await newFamily(api, 'Missing');
    assert.equal(
      await api.fails('POST', `/families/${NO_ID}/members`, 404, { person: { fname: 'A' }, relationship: 'aunt' }),
      `Family ${NO_ID} not found`,
    );
    assert.equal(
      await api.fails('POST', `/families/${id}/members`, 404, { person_id: NO_ID, relationship: 'aunt' }),
      `Person ${NO_ID} not found`,
    );
  });
});

describe('PATCH /families/:id/members/:memberId', () => {
  test('200; making a member primary clears the other primary member', async () => {
    const id = await newFamily(api, 'Primary');
    const dad = await newMember(api, id, 'Avi', 'father', { is_primary: true });
    const mom = await newMember(api, id, 'Sara', 'mother');
    const res = await api.ok('PATCH', `/families/${id}/members/${mom.id}`, { is_primary: true, sort_order: 2 });
    assert.deepEqual([res.is_primary, res.sort_order], [true, 2]);
    const family = await api.ok('GET', `/families/${id}`);
    const primary = family.members
      .filter((m: { is_primary: boolean }) => m.is_primary)
      .map((m: { id: number }) => m.id);
    assert.deepEqual(primary, [mom.id]);
    assert.notEqual(primary[0], dad.id);
  });

  test('400: an empty body or an unknown relationship; 404: unknown member, or a member of another family', async () => {
    const id = await newFamily(api, 'PatchMember');
    const other = await newFamily(api, 'OtherFamily');
    const m = await newMember(api, id, 'Avi', 'father');
    assert.equal((await api.request('PATCH', `/families/${id}/members/${m.id}`, {})).statusCode, 400);
    assert.equal(
      (await api.request('PATCH', `/families/${id}/members/${m.id}`, { relationship: 'pal' })).statusCode,
      400,
    );
    assert.equal(
      await api.fails('PATCH', `/families/${id}/members/${NO_ID}`, 404, { sort_order: 1 }),
      `Member ${NO_ID} of family ${id} not found`,
    );
    assert.equal(
      await api.fails('PATCH', `/families/${other}/members/${m.id}`, 404, { sort_order: 1 }),
      `Member ${m.id} of family ${other} not found`,
    );
  });
});

describe('DELETE /families/:id/members/:memberId', () => {
  test('200 with the member, status trash; no longer listed; 404 the second time', async () => {
    const id = await newFamily(api, 'Remove');
    const m = await newMember(api, id, 'Avi', 'father');
    const removed = await api.ok('DELETE', `/families/${id}/members/${m.id}`);
    assert.deepEqual([removed.id, removed.status], [m.id, 'trash']);
    assert.deepEqual((await api.ok('GET', `/families/${id}`)).members, []);
    assert.equal(
      await api.fails('DELETE', `/families/${id}/members/${m.id}`, 404),
      `Member ${m.id} of family ${id} not found`,
    );
  });

  test('404 for an unknown family or member; 400 for a bad id', async () => {
    const id = await newFamily(api, 'RemoveMissing');
    assert.equal(await api.fails('DELETE', `/families/${NO_ID}/members/1`, 404), `Family ${NO_ID} not found`);
    assert.equal(
      await api.fails('DELETE', `/families/${id}/members/${NO_ID}`, 404),
      `Member ${NO_ID} of family ${id} not found`,
    );
    assert.equal((await api.request('DELETE', `/families/${id}/members/x`)).statusCode, 400);
  });
});
