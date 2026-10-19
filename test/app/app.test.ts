// App-level tests through app.inject() (no listening socket): /health, the JSON error format,
// CORS and the served OpenAPI document. /health needs the local MariaDB from .env.

import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import Type from 'typebox';
import { buildApp, OPENAPI_JSON_PATH } from '../../src/app.ts';
import { loadConfig } from '../../src/config.ts';

const config = { ...loadConfig(), logLevel: 'silent' as const, redisUrl: undefined };
const app = await buildApp(config);

// Routes that exist only to exercise the error handler.
app.get('/__test/needs-number', { schema: { querystring: Type.Object({ n: Type.Integer() }) } }, async () => ({}));
app.get('/__test/fails', async () => {
  throw new Error('secret detail that must not leak');
});

after(() => app.close());

describe('app', () => {
  test('GET /health checks the database pool', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { status: 'ok', db: 'ok', redis: 'disabled' });
  });

  test('errors use { statusCode, error, message }: unknown route, validation, server error', async () => {
    const notFound = await app.inject({ method: 'GET', url: '/nope' });
    assert.equal(notFound.statusCode, 404);
    assert.deepEqual(notFound.json(), { statusCode: 404, error: 'Not Found', message: 'Route GET /nope not found' });

    const invalid = await app.inject({ method: 'GET', url: '/__test/needs-number?n=abc' });
    assert.equal(invalid.statusCode, 400);
    assert.deepEqual(Object.keys(invalid.json()).sort(), ['error', 'message', 'statusCode']);
    assert.equal(invalid.json().error, 'Bad Request');

    const failed = await app.inject({ method: 'GET', url: '/__test/fails' });
    assert.deepEqual(failed.json(), {
      statusCode: 500,
      error: 'Internal Server Error',
      message: 'Internal Server Error',
    });
  });

  test('CORS allows CORS_ORIGIN only', async () => {
    const allowed = config.corsOrigins[0];
    const ok = await app.inject({
      method: 'OPTIONS',
      url: '/health',
      headers: { origin: allowed, 'access-control-request-method': 'GET' },
    });
    assert.equal(ok.headers['access-control-allow-origin'], allowed);

    const other = await app.inject({ method: 'GET', url: '/health', headers: { origin: 'http://evil.example' } });
    assert.equal(other.headers['access-control-allow-origin'], undefined);
  });

  test(`GET ${OPENAPI_JSON_PATH} serves the OpenAPI document`, async () => {
    const res = await app.inject({ method: 'GET', url: OPENAPI_JSON_PATH });
    assert.equal(res.statusCode, 200);
    const doc = res.json();
    assert.equal(doc.openapi, '3.0.3');
    assert.ok(doc.paths['/health'], 'routes appear in the document');
    assert.equal(doc.paths[OPENAPI_JSON_PATH], undefined, 'the document route itself is hidden');
  });
});
