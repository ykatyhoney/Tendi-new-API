// The Family API contract (step 3.3): the published OpenAPI document, and the staff auth running
// before validation. Validation with a token is tested in test/family-db/contract.test.ts.

import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { buildApp, OPENAPI_JSON_PATH } from '../../src/app.ts';
import { loadConfig } from '../../src/config.ts';
import {
  ADDRESS_KINDS,
  LINK_WARNING_CODES,
  NOTIFY_METHODS,
  PHONE_CHANNELS,
  RELATIONSHIPS,
} from '../../src/modules/family/schemas/values.ts';

const app = await buildApp({ ...loadConfig(), logLevel: 'silent', redisUrl: undefined });
after(() => app.close());

const EXPECTED_OPERATIONS = {
  'GET /families': 'searchFamilies',
  'POST /families': 'createFamily',
  'GET /families/{id}': 'getFamily',
  'PATCH /families/{id}': 'updateFamily',
  'POST /families/{id}/members': 'addFamilyMember',
  'PATCH /families/{id}/members/{memberId}': 'updateFamilyMember',
  'DELETE /families/{id}/members/{memberId}': 'removeFamilyMember',
  'GET /people/{id}': 'getPerson',
  'PATCH /people/{id}': 'updatePerson',
  'PUT /people/{id}/phones': 'replacePersonPhones',
  'PUT /people/{id}/addresses': 'replacePersonAddresses',
  'PUT /families/{id}/children/{childId}/rights': 'setChildRights',
  'GET /families/{id}/children/{childId}/preview': 'previewChildLink',
  'POST /families/{id}/children/{childId}/link': 'linkChild',
  'GET /children': 'searchChildren',
  'POST /children/{childId}/unlink': 'unlinkChild',
  'GET /staff/me': 'getCurrentStaff',
  'GET /health/family': 'getFamilyHealth',
};

async function openapi() {
  return (await app.inject({ method: 'GET', url: OPENAPI_JSON_PATH })).json();
}

describe('family API contract', () => {
  test('every PLAN.md endpoint is published with its operationId and the family tag', async () => {
    const doc = await openapi();
    const family: Record<string, string> = {};
    for (const [path, item] of Object.entries<Record<string, { operationId?: string; tags?: string[] }>>(doc.paths)) {
      for (const [method, op] of Object.entries(item)) {
        if (op.tags?.includes('family')) family[`${method.toUpperCase()} ${path}`] = op.operationId ?? '(none)';
      }
    }
    assert.deepEqual(family, EXPECTED_OPERATIONS);
  });

  test('enums and lengths match SCHEMA.md', async () => {
    const s = (await openapi()).components.schemas;
    assert.deepEqual(s.FamilyMember.properties.relationship.enum, [...RELATIONSHIPS]);
    assert.equal(RELATIONSHIPS.length, 19);
    assert.equal(s.FamilyMember.properties.relationship.maxLength, 32);
    assert.deepEqual(s.ChildRight.properties.notify_method.enum, [...NOTIFY_METHODS]);
    assert.deepEqual(s.PersonPhone.properties.channel.enum, [...PHONE_CHANNELS]);
    assert.deepEqual(s.PersonAddress.properties.kind.enum, [...ADDRESS_KINDS]);
    assert.equal(s.Family.properties.name.maxLength, 100);
    assert.equal(s.Person.properties.fname.maxLength, 100);
    assert.equal(s.Person.properties.legacy_full_name.maxLength, 100);
    assert.equal(s.Person.properties.email.maxLength, 255);
    assert.equal(s.PersonPhone.properties.phone_normalized.maxLength, 20);
    assert.equal(s.PersonAddress.properties.state.maxLength, 25);
    assert.equal(s.PersonAddress.properties.zip.maxLength, 15);
    assert.deepEqual(s.ChildRight.properties.collect_to, {
      anyOf: [{ type: 'string', format: 'date' }, { type: 'null' }],
    });
    assert.deepEqual([s.LinkPreview.properties.columns.minItems, s.LinkPreview.properties.columns.maxItems], [29, 29]);
    assert.deepEqual(s.LinkWarning.properties.code.enum, [...LINK_WARNING_CODES]);
  });

  test('phone_normalized is not part of the phone request body', async () => {
    const doc = await openapi();
    const body = doc.paths['/people/{id}/phones'].put.requestBody.content['application/json'].schema;
    assert.deepEqual(Object.keys(body.properties.phones.items.properties).sort(), [
      'channel',
      'is_primary',
      'label',
      'phone',
      'sort_order',
    ]);
    assert.equal(body.properties.phones.items.additionalProperties, false);
  });

  test('without a token every family route answers 401 before any validation', async () => {
    for (const [method, url, payload] of [
      ['POST', '/families', { name: 'Katz' }],
      ['POST', '/families', { name: 'x'.repeat(101), bogus: 1 }],
      ['PUT', '/people/1/phones', { phones: [{ phone: '1', label: 'pager' }] }],
      ['PATCH', '/people/0', { fnmae: 'A' }],
    ] as const) {
      const res = await app.inject({ method, url, payload });
      assert.equal(res.statusCode, 401, `${method} ${url}`);
      assert.equal(res.json().error, 'Unauthorized');
    }
  });
});
