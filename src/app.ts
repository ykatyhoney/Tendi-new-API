// Builds the Fastify app without listening, so tests can use app.inject().
// Shared resources (config, database pool, Redis) are decorations on the root instance; each
// module is a Fastify plugin in its own folder under src/modules/ and registered here.

import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import Fastify from 'fastify';
import type { Pool } from 'mysql2/promise';
import { type Config, loadConfig } from './config.ts';
import { createPool } from './db/pool.ts';
import { ErrorResponse, registerErrorHandling } from './errors.ts';
import familyModule from './modules/family/index.ts';
import healthModule from './modules/health/index.ts';
import { connectRedis, type RedisClient } from './redis.ts';

declare module 'fastify' {
  interface FastifyInstance {
    config: Config;
    db: Pool;
    redis: RedisClient | null;
  }
}

/** Path of the OpenAPI document served by the running app. */
export const OPENAPI_JSON_PATH = '/openapi.json';

export async function buildApp(config: Config = loadConfig()) {
  const app = Fastify({ logger: { level: config.logLevel } }).withTypeProvider<TypeBoxTypeProvider>();

  const pool = createPool(config.db);
  const redis = await connectRedis(config.redisUrl, app.log);
  app.decorate('config', config);
  app.decorate('db', pool);
  app.decorate('redis', redis);
  app.addHook('onClose', async () => {
    await pool.end();
    await redis?.close();
  });

  registerErrorHandling(app);
  app.addSchema(ErrorResponse);

  await app.register(cors, { origin: config.corsOrigins, credentials: true });
  await app.register(swagger, {
    openapi: {
      openapi: '3.0.3',
      info: { title: 'Tendi Family API', version: '0.1.0' },
      servers: [{ url: `http://localhost:${config.port}` }],
    },
    // Shared schemas appear under their $id (e.g. ErrorResponse), so generated client types get stable names.
    refResolver: {
      buildLocalReference: (json, _baseUri, _fragment, i) => (typeof json.$id === 'string' ? json.$id : `def-${i}`),
    },
  });
  app.get(OPENAPI_JSON_PATH, { schema: { hide: true } }, async () => app.swagger());

  await app.register(healthModule);
  await app.register(familyModule);

  return app;
}

export type App = Awaited<ReturnType<typeof buildApp>>;
