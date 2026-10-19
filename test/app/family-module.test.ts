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
});
