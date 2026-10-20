// PUT /families/:id/children/:childId/rights, GET .../preview, POST .../link and
// POST /children/:childId/unlink: happy path, validation (400), 404 and 409. Each test is rolled
// back, links included: the mirror's writes to children / children_additional_information are
// part of the test's transaction.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { RowDataPacket } from 'mysql2/promise';
import { NO_ID, freeChildren, newFamily, newMember, readyFamily, useApi } from './support/api.ts';

const api = useApi();

type Column = { column: string; current: unknown; after_link: unknown; changed: boolean };
const column = (preview: { columns: Column[] }, name: string) => preview.columns.find((c) => c.column === name)!;

async function familyIdOf(childId: number) {
  const [[row]] = await api
    .db()
    .query<RowDataPacket[]>('SELECT family_id, father_phone FROM children WHERE id = ?', [childId]);
  return row;
}

describe('GET /children', () => {
  async function child(id: number) {
    const [[row]] = await api
      .db()
      .query<RowDataPacket[]>('SELECT id, fname, lname, status FROM children WHERE id = ?', [id]);
    return row;
  }
  const ids = (result: { items: { id: number }[] }) => result.items.map((c) => c.id);

  test('by first name, last name, "first last" and exact id; with the class and no family when unlinked', async () => {
    const [id] = await freeChildren(api, 1);
    const c = await child(id);
    for (const q of [c.fname, c.lname, `${c.fname} ${c.lname}`, `${c.lname} ${c.fname}`, String(id)]) {
      const result = await api.ok('GET', `/children?q=${encodeURIComponent(q)}&pageSize=100`);
      assert.ok(ids(result).includes(id), `q=${q}`);
    }
    const byId = await api.ok('GET', `/children?q=${id}`);
    assert.equal(byId.total, 1);
    assert.deepEqual(
      { ...byId.items[0], class_id: undefined, class_name: undefined },
      {
        id,
        fname: c.fname,
        lname: c.lname,
        status: 'active',
        class_id: undefined,
        class_name: undefined,
        family_id: null,
        family_name: null,
      },
    );
  });

  test('a linked child shows its family; a trashed child is not found; active children come first', async () => {
    const [id] = await freeChildren(api, 1);
    const { familyId } = await readyFamily(api, 'SearchLinked', [id]);
    await api.ok('POST', `/families/${familyId}/children/${id}/link`);
    const linked = await api.ok('GET', `/children?q=${id}`);
    assert.deepEqual([linked.items[0].family_id, linked.items[0].family_name], [familyId, 'SearchLinked']);

    const [[inactive]] = await api
      .db()
      .query<RowDataPacket[]>("SELECT id, lname FROM children WHERE status = 'inactive' ORDER BY id LIMIT 1");
    assert.equal((await api.ok('GET', `/children?q=${inactive.id}`)).items[0].status, 'inactive');
    const [[trashed]] = await api.db().query<RowDataPacket[]>("SELECT id FROM children WHERE status = 'trash' LIMIT 1");
    assert.equal((await api.ok('GET', `/children?q=${trashed.id}`)).total, 0);

    const all = await api.ok('GET', '/children?q=an&pageSize=100');
    const statuses = all.items.map((c: { status: string }) => c.status);
    assert.deepEqual(
      statuses,
      [...statuses].sort((a: string, b: string) => (a === b ? 0 : a === 'active' ? -1 : 1)),
    );
  });

  test('paging; no match is an empty page', async () => {
    const page1 = await api.ok('GET', '/children?q=an&page=1&pageSize=2');
    const page2 = await api.ok('GET', '/children?q=an&page=2&pageSize=2');
    assert.equal(page1.items.length, 2);
    assert.equal(page1.total, page2.total);
    assert.notDeepEqual(ids(page1), ids(page2));
    assert.deepEqual(await api.ok('GET', '/children?q=zzqqxx'), { items: [], total: 0, page: 1, page_size: 20 });
  });

  test('400: q missing or shorter than 2 characters, pageSize over 100, an unknown parameter', async () => {
    assert.equal((await api.request('GET', '/children')).statusCode, 400);
    assert.match(await api.fails('GET', '/children?q=%20a%20', 400), /at least 2 characters/);
    assert.equal((await api.request('GET', '/children?q=1')).statusCode, 200, 'a one-digit id is fine');
    assert.equal((await api.request('GET', '/children?q=an&pageSize=101')).statusCode, 400);
    assert.match(await api.fails('GET', '/children?q=an&family=1', 400), /additional properties/);
  });
});

describe('PUT /families/:id/children/:childId/rights', () => {
  test('200 with the rows; the same member updated in place, an unlisted one deleted', async () => {
    const [childId] = await freeChildren(api, 1);
    const id = await newFamily(api, 'Rights');
    const dad = await newMember(api, id, 'Avi', 'father');
    const mom = await newMember(api, id, 'Sara', 'mother', { sort_order: 1 });
    const url = `/families/${id}/children/${childId}/rights`;
    const first = await api.ok('PUT', url, {
      rights: [
        { member_id: dad.id, receives_notifications: true },
        { member_id: mom.id, may_collect: true, collect_from: '2026-09-01' },
      ],
    });
    assert.deepEqual(
      first.rights.map((r: Record<string, unknown>) => [
        r.member_id,
        r.receives_notifications,
        r.may_collect,
        r.collect_from,
      ]),
      [
        [dad.id, true, false, null],
        [mom.id, false, true, '2026-09-01'],
      ],
    );
    const second = await api.ok('PUT', url, { rights: [{ member_id: dad.id, is_emergency: true }] });
    assert.deepEqual(
      second.rights.map((r: Record<string, unknown>) => [r.id, r.is_emergency, r.receives_notifications]),
      [[first.rights[0].id, true, false]],
    );
  });

  test('409 for a member of another family, a removed member or an unknown member id', async () => {
    const [childId] = await freeChildren(api, 1);
    const id = await newFamily(api, 'RightsConflict');
    const other = await newFamily(api, 'RightsOther');
    const dad = await newMember(api, id, 'Avi', 'father');
    const uncle = await newMember(api, id, 'Dov', 'uncle');
    const stranger = await newMember(api, other, 'Eli', 'father');
    await api.ok('DELETE', `/families/${id}/members/${uncle.id}`);
    const url = `/families/${id}/children/${childId}/rights`;
    for (const [i, memberId] of [stranger.id, uncle.id, NO_ID].entries()) {
      assert.equal(
        await api.fails('PUT', url, 409, { rights: [{ member_id: dad.id }, { member_id: memberId }] }),
        `rights/1/member_id: ${memberId} is not an active member of family ${id}`,
        `case ${i}`,
      );
    }
    assert.deepEqual(
      (await api.ok('PUT', url, { rights: [] })).rights,
      [],
      'nothing was written by the refused requests',
    );
  });

  test('400: a member twice, collect_to before collect_from, an unknown notify_method or field', async () => {
    const [childId] = await freeChildren(api, 1);
    const id = await newFamily(api, 'RightsInvalid');
    const dad = await newMember(api, id, 'Avi', 'father');
    const url = `/families/${id}/children/${childId}/rights`;
    assert.match(
      await api.fails('PUT', url, 400, { rights: [{ member_id: dad.id }, { member_id: dad.id }] }),
      /more than once/,
    );
    assert.match(
      await api.fails('PUT', url, 400, {
        rights: [{ member_id: dad.id, collect_from: '2026-09-02', collect_to: '2026-09-01' }],
      }),
      /on or after collect_from/,
    );
    assert.equal(
      (await api.request('PUT', url, { rights: [{ member_id: dad.id, notify_method: 'pigeon' }] })).statusCode,
      400,
    );
    assert.equal(
      (await api.request('PUT', url, { rights: [{ member_id: dad.id, child_id: childId }] })).statusCode,
      400,
    );
    assert.equal(
      (await api.request('PUT', url, { rights: [{ member_id: dad.id, collect_from: '01/09/2026' }] })).statusCode,
      400,
    );
  });

  test('404 for an unknown family or child', async () => {
    const [childId] = await freeChildren(api, 1);
    const id = await newFamily(api, 'Rights404');
    assert.equal(
      await api.fails('PUT', `/families/${NO_ID}/children/${childId}/rights`, 404, { rights: [] }),
      `Family ${NO_ID} not found`,
    );
    assert.equal(
      await api.fails('PUT', `/families/${id}/children/${NO_ID}/rights`, 404, { rights: [] }),
      `Child ${NO_ID} not found`,
    );
  });
});

describe('GET /families/:id/children/:childId/preview', () => {
  test('200: the 29 columns now and after linking, with warnings; writes nothing', async () => {
    const [childId] = await freeChildren(api, 1);
    const { familyId } = await readyFamily(api, 'Preview', [childId]);
    const before = await familyIdOf(childId);
    const preview = await api.ok('GET', `/families/${familyId}/children/${childId}/preview`);
    assert.equal(preview.columns.length, 29);
    assert.deepEqual(
      [column(preview, 'father_phone').after_link, column(preview, 'father_name').after_link],
      ['347-555-0101', 'Avi Testerman'],
    );
    assert.equal(column(preview, 'home_send_notification').changed, false);
    assert.deepEqual(
      preview.warnings.map((w: { code: string }) => w.code),
      ['no_mother'],
    );
    assert.deepEqual(await familyIdOf(childId), before);
  });

  test('409 when the mirror refuses a value (too long for its legacy column)', async () => {
    const [childId] = await freeChildren(api, 1);
    const { familyId, father } = await readyFamily(api, 'PreviewSignal', [childId]);
    // family_api may write people directly; the API itself refuses an email over 150 characters.
    await api.db().query('UPDATE people SET email = ? WHERE id = ?', [`${'a'.repeat(145)}@x.test`, father.person_id]);
    assert.equal(
      await api.fails('GET', `/families/${familyId}/children/${childId}/preview`, 409),
      `Family value too long for children_additional_information.father_email (150), child ${childId}`,
    );
  });

  test('404 for an unknown family or child; 400 for a bad child id', async () => {
    const [childId] = await freeChildren(api, 1);
    const id = await newFamily(api, 'Preview404');
    assert.equal(
      await api.fails('GET', `/families/${NO_ID}/children/${childId}/preview`, 404),
      `Family ${NO_ID} not found`,
    );
    assert.equal(await api.fails('GET', `/families/${id}/children/${NO_ID}/preview`, 404), `Child ${NO_ID} not found`);
    assert.equal((await api.request('GET', `/families/${id}/children/-1/preview`)).statusCode, 400);
  });
});

describe('POST /families/:id/children/:childId/link', () => {
  test('200: linked, the mirror wrote the values, the fresh preview shows no change', async () => {
    const [childId] = await freeChildren(api, 1);
    const { familyId } = await readyFamily(api, 'Link', [childId]);
    const linked = await api.ok('POST', `/families/${familyId}/children/${childId}/link`);
    assert.equal(linked.linked_family_id, familyId);
    assert.deepEqual(
      linked.columns.filter((c: Column) => c.changed),
      [],
    );
    assert.deepEqual({ ...(await familyIdOf(childId)) }, { family_id: familyId, father_phone: '347-555-0101' });
  });

  test('409: a child already linked to this family', async () => {
    const [childId] = await freeChildren(api, 1);
    const { familyId } = await readyFamily(api, 'LinkTwice', [childId]);
    await api.ok('POST', `/families/${familyId}/children/${childId}/link`);
    assert.equal(
      await api.fails('POST', `/families/${familyId}/children/${childId}/link`, 409),
      `Child ${childId} is already linked to family ${familyId}`,
    );
  });

  test('409: linked to another family without force=move; 200 with it', async () => {
    const [childId] = await freeChildren(api, 1);
    const { familyId: first } = await readyFamily(api, 'LinkFirst', [childId]);
    const { familyId: second } = await readyFamily(api, 'LinkSecond', [childId]);
    await api.ok('POST', `/families/${first}/children/${childId}/link`);
    assert.match(await api.fails('POST', `/families/${second}/children/${childId}/link`, 409), /send force=move/);
    assert.equal(
      (await api.ok('POST', `/families/${second}/children/${childId}/link?force=move`)).linked_family_id,
      second,
    );
  });

  test('409: no rights row of an active member; 400: force other than move; 404: unknown family or child', async () => {
    const [childId] = await freeChildren(api, 1);
    const id = await newFamily(api, 'LinkNoRights');
    await newMember(api, id, 'Avi', 'father');
    assert.match(await api.fails('POST', `/families/${id}/children/${childId}/link`, 409), /has no rights rows/);
    assert.equal((await familyIdOf(childId)).family_id, null);
    assert.equal((await api.request('POST', `/families/${id}/children/${childId}/link?force=yes`)).statusCode, 400);
    assert.equal(
      await api.fails('POST', `/families/${NO_ID}/children/${childId}/link`, 404),
      `Family ${NO_ID} not found`,
    );
    assert.equal(await api.fails('POST', `/families/${id}/children/${NO_ID}/link`, 404), `Child ${NO_ID} not found`);
  });
});

describe('POST /children/:childId/unlink', () => {
  test('200: family_id back to NULL, the values stay', async () => {
    const [childId] = await freeChildren(api, 1);
    const { familyId } = await readyFamily(api, 'Unlink', [childId]);
    await api.ok('POST', `/families/${familyId}/children/${childId}/link`);
    assert.deepEqual(await api.ok('POST', `/children/${childId}/unlink`), { child_id: childId, family_id: null });
    assert.deepEqual({ ...(await familyIdOf(childId)) }, { family_id: null, father_phone: '347-555-0101' });
  });

  test('409 when not linked; 404 for an unknown child; 400 for a bad id', async () => {
    const [childId] = await freeChildren(api, 1);
    assert.equal(
      await api.fails('POST', `/children/${childId}/unlink`, 409),
      `Child ${childId} is not linked to a family`,
    );
    assert.equal(await api.fails('POST', `/children/${NO_ID}/unlink`, 404), `Child ${NO_ID} not found`);
    assert.equal((await api.request('POST', '/children/0/unlink')).statusCode, 400);
  });
});
