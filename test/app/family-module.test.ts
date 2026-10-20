// The family module through app.inject(): it registers, and its own pool (family_api) answers.
// Needs the local MariaDB and the family_api account (npm run db:family:grants).

import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { buildApp } from '../../src/app.ts';
import { loadConfig } from '../../src/config.ts';
import { loadFamilyConfig } from '../../src/modules/family/config.ts';

const app = await buildApp({ ...loadConfig(), logLevel: 'silent', redisUrl: undefined });
after(() => app.close());

describe('family module', () => {
  test('GET /health/family checks the family pool', async () => {
    const res = await app.inject({ method: 'GET', url: '/health/family' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { status: 'ok', db: 'ok' });
  });

  test('its config requires the family_api credentials', () => {
    assert.throws(
      () => loadFamilyConfig({ FAMILY_DB_USER: 'family_api', FAMILY_DB_PASSWORD: '' }),
      /invalid configuration.*FAMILY_DB_PASSWORD/,
    );
  });

  test('the allowed staff types come from config: default admin, superadmin, office; unknown types rejected', () => {
    const base = { FAMILY_DB_USER: 'family_api', FAMILY_DB_PASSWORD: 'x' };
    assert.deepEqual(loadFamilyConfig({ ...base, FAMILY_ALLOWED_STAFF_TYPES: undefined }).allowedStaffTypes, [
      'admin',
      'superadmin',
      'office',
    ]);
    assert.deepEqual(
      loadFamilyConfig({ ...base, FAMILY_ALLOWED_STAFF_TYPES: 'admin, office ,superadmin' }).allowedStaffTypes,
      ['admin', 'office', 'superadmin'],
    );
    assert.throws(
      () => loadFamilyConfig({ ...base, FAMILY_ALLOWED_STAFF_TYPES: 'admin,offce' }),
      /unknown admin types: offce/,
    );
  });

  test('family API routes require a bearer token', async () => {
    const res = await app.inject({ method: 'GET', url: '/staff/me' });
    assert.equal(res.statusCode, 401);
  });

  test("a CORS preflight from Tendi-new's origin succeeds without a token", async () => {
    const origin = loadConfig().corsOrigins[0];
    assert.equal(origin, 'http://localhost:3000', "CORS_ORIGIN is Tendi-new's local URL");
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/staff/me',
      headers: { origin, 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' },
    });
    assert.equal(res.statusCode, 204);
    assert.equal(res.headers['access-control-allow-origin'], origin);
    assert.match(String(res.headers['access-control-allow-headers']), /authorization/i);
    assert.equal(res.headers['www-authenticate'], undefined, 'the preflight never reaches the auth preHandler');
  });
});
