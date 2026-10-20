// Every Family API endpoint behind the staff auth: 401 without a token or with an unknown one, 403
// for a staff type that is not allowed (teacher), before any validation or lookup. GET /staff/me
// and the public GET /health/family.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { type Method, NO_ID, useApi } from './support/api.ts';

const api = useApi();

/** Every protected route, with a body that would otherwise fail validation or find nothing. */
const ROUTES: [Method, string, object?][] = [
  ['GET', '/families?q=Katz'],
  ['POST', '/families', { name: 'Katz', bogus: 1 }],
  ['GET', `/families/${NO_ID}`],
  ['PATCH', `/families/${NO_ID}`, { name: 'Katz' }],
  ['POST', `/families/${NO_ID}/members`, { relationship: 'father' }],
  ['PATCH', `/families/${NO_ID}/members/${NO_ID}`, { sort_order: 1 }],
  ['DELETE', `/families/${NO_ID}/members/${NO_ID}`],
  ['GET', `/people/${NO_ID}`],
  ['PATCH', `/people/${NO_ID}`, { fname: 'Avi' }],
  ['PUT', `/people/${NO_ID}/phones`, { phones: [] }],
  ['PUT', `/people/${NO_ID}/addresses`, { addresses: [] }],
  ['PUT', `/families/${NO_ID}/children/${NO_ID}/rights`, { rights: [] }],
  ['GET', `/families/${NO_ID}/children/${NO_ID}/preview`],
  ['POST', `/families/${NO_ID}/children/${NO_ID}/link`],
  ['POST', `/children/${NO_ID}/unlink`],
  ['GET', '/staff/me'],
];

describe('staff auth on every endpoint', () => {
  test('401 without a token, with WWW-Authenticate: Bearer', async () => {
    for (const [method, url, payload] of ROUTES) {
      const res = await api.request(method, url, payload, null);
      assert.equal(res.statusCode, 401, `${method} ${url}`);
      assert.equal(res.headers['www-authenticate'], 'Bearer');
      assert.equal(res.json().error, 'Unauthorized');
    }
  });

  test('401 with an unknown token', async () => {
    for (const [method, url, payload] of ROUTES) {
      const res = await api.request(method, url, payload, { token: 'not-a-real-token' });
      assert.equal(res.statusCode, 401, `${method} ${url}`);
    }
  });

  test('403 for a staff type that is not allowed (teacher)', async () => {
    for (const [method, url, payload] of ROUTES) {
      const res = await api.request(method, url, payload, 'teacher');
      assert.equal(res.statusCode, 403, `${method} ${url}`);
      assert.equal(res.json().error, 'Forbidden');
    }
  });

  test('GET /staff/me returns the staff member; admin and office are allowed', async () => {
    const me = await api.ok('GET', '/staff/me');
    assert.equal(me.admin_id, api.adminId('office'));
    assert.equal(me.type, 'office');
    const asAdmin = await api.request('GET', '/staff/me', undefined, 'admin');
    assert.equal(asAdmin.statusCode, 200);
    assert.equal(asAdmin.json().admin_id, api.adminId('admin'));
  });

  test('GET /health/family needs no token', async () => {
    const res = await api.request('GET', '/health/family', undefined, null);
    assert.equal(res.statusCode, 200);
  });
});
