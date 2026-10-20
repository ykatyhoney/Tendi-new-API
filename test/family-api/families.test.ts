// GET /families, POST /families, GET /families/:id, PATCH /families/:id: happy path, validation
// (400), unknown or trashed family (404). Each test is rolled back (support/api.ts).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { NO_ID, newFamily, newMember, useApi } from './support/api.ts';

const api = useApi();

describe('the harness', () => {
  test('a test sees its own writes …', async () => {
    await newFamily(api, 'Harnesscheck Rollback');
    assert.equal((await api.ok('GET', '/families?q=Harnesscheck')).total, 1);
  });

  test('… and the next test does not: each test is rolled back', async () => {
    assert.equal((await api.ok('GET', '/families?q=Harnesscheck')).total, 0);
  });
});

describe('GET /families', () => {
  test('by family name, by person name, by full phone and by phone suffix', async () => {
    const id = await newFamily(api, 'Qwertyfam Katz', '(718) 555-0199');
    await newMember(api, id, 'Zebulun', 'father', { phone: '347-555-0177' });
    const ids = async (q: string) =>
      (await api.ok('GET', `/families?q=${encodeURIComponent(q)}`)).items.map((f: { id: number }) => f.id);
    assert.deepEqual(await ids('qwertyfam'), [id]);
    assert.deepEqual(await ids('Zebulun'), [id]);
    assert.ok((await ids('7185550199')).includes(id));
    assert.ok((await ids('347-555-0177')).includes(id));
    assert.ok((await ids('5550177')).includes(id));

    const page = await api.ok('GET', '/families?q=qwertyfam&page=1&pageSize=5');
    assert.deepEqual([page.total, page.page, page.page_size], [1, 1, 5]);
    assert.deepEqual(page.items[0].members, [
      {
        person_id: page.items[0].members[0].person_id,
        name: 'Zebulun Testerman',
        relationship: 'father',
        is_primary: false,
      },
    ]);
  });

  test('400: q too short, pageSize above 100, an unknown parameter', async () => {
    assert.match(await api.fails('GET', '/families?q=%20a%20', 400), /at least 2 characters/);
    assert.equal((await api.request('GET', '/families?q=a')).statusCode, 400);
    assert.equal((await api.request('GET', '/families?pageSize=101')).statusCode, 400);
    assert.equal((await api.request('GET', '/families?page=0')).statusCode, 400);
    assert.match(await api.fails('GET', '/families?query=Katz', 400), /additional properties/);
  });
});

describe('POST /families', () => {
  test('201 with the household, no members and no children', async () => {
    const family = await api.ok('POST', '/families', { name: 'Katz', household_phone: '718-555-0199' }, 201);
    assert.deepEqual(
      [family.name, family.household_phone, family.status, family.members, family.children],
      ['Katz', '718-555-0199', 'active', [], []],
    );
    assert.equal((await api.ok('POST', '/families', { name: 'NoPhone' }, 201)).household_phone, '');
  });

  test('400: missing or empty name, an unknown field, a household_phone over 30 characters', async () => {
    assert.match(await api.fails('POST', '/families', 400, {}), /name/);
    assert.equal((await api.request('POST', '/families', { name: '' })).statusCode, 400);
    assert.equal((await api.request('POST', '/families', { name: 'x'.repeat(101) })).statusCode, 400);
    assert.match(await api.fails('POST', '/families', 400, { name: 'Katz', status: 'trash' }), /additional properties/);
    assert.match(
      await api.fails('POST', '/families', 400, { name: 'Katz', household_phone: '7'.repeat(31) }),
      /household_phone/,
    );
  });
});

describe('GET /families/:id', () => {
  test('200 with members, phones and children', async () => {
    const id = await newFamily(api, 'Detail');
    const m = await newMember(api, id, 'Avi', 'father', { phone: '347-555-0101' });
    const family = await api.ok('GET', `/families/${id}`);
    assert.equal(family.id, id);
    assert.deepEqual(
      family.members.map((x: { id: number; person: { phones: { phone: string }[] } }) => [
        x.id,
        x.person.phones[0].phone,
      ]),
      [[m.id, '347-555-0101']],
    );
  });

  test('404 for an unknown or trashed family; 400 for an id that is not a positive integer', async () => {
    assert.equal(await api.fails('GET', `/families/${NO_ID}`, 404), `Family ${NO_ID} not found`);
    const id = await newFamily(api, 'Trashed');
    await api.db().query("UPDATE families SET status = 'trash' WHERE id = ?", [id]);
    assert.equal(await api.fails('GET', `/families/${id}`, 404), `Family ${id} not found`);
    assert.equal((await api.request('GET', '/families/0')).statusCode, 400);
    assert.equal((await api.request('GET', '/families/abc')).statusCode, 400);
  });
});

describe('PATCH /families/:id', () => {
  test('200 with the edited household', async () => {
    const id = await newFamily(api, 'Before');
    const family = await api.ok('PATCH', `/families/${id}`, { name: 'After', household_phone: '718-555-0123' });
    assert.deepEqual([family.name, family.household_phone], ['After', '718-555-0123']);
  });

  test('400: an empty body, an unknown field, a household_phone over 30 characters; 404 unknown', async () => {
    const id = await newFamily(api, 'PatchCheck');
    assert.equal((await api.request('PATCH', `/families/${id}`, {})).statusCode, 400);
    assert.match(await api.fails('PATCH', `/families/${id}`, 400, { status: 'trash' }), /additional properties/);
    assert.equal((await api.request('PATCH', `/families/${id}`, { household_phone: '7'.repeat(31) })).statusCode, 400);
    assert.equal(await api.fails('PATCH', `/families/${NO_ID}`, 404, { name: 'X' }), `Family ${NO_ID} not found`);
  });
});
