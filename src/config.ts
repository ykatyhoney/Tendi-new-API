// App configuration: read from the environment (and .env, which the environment overrides),
// validated with TypeBox at startup. A missing or invalid value stops the app with a clear error.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import Type, { type Static, type TObject } from 'typebox';
import Value from 'typebox/value';

export const API_ROOT = join(import.meta.dirname, '..');

const EnvSchema = Type.Object({
  NODE_ENV: Type.Union([Type.Literal('development'), Type.Literal('test'), Type.Literal('production')], {
    default: 'development',
  }),
  HOST: Type.String({ minLength: 1, default: '127.0.0.1' }),
  PORT: Type.Integer({ minimum: 1, maximum: 65535, default: 4000 }),
  LOG_LEVEL: Type.Union(
    [
      Type.Literal('fatal'),
      Type.Literal('error'),
      Type.Literal('warn'),
      Type.Literal('info'),
      Type.Literal('debug'),
      Type.Literal('trace'),
      Type.Literal('silent'),
    ],
    { default: 'info' },
  ),
  DB_HOST: Type.String({ minLength: 1 }),
  DB_PORT: Type.Integer({ minimum: 1, maximum: 65535, default: 3306 }),
  DB_NAME: Type.String({ minLength: 1 }),
  DB_USER: Type.String({ minLength: 1 }),
  DB_PASSWORD: Type.String({ default: '' }),
  DB_POOL_SIZE: Type.Integer({ minimum: 1, default: 10 }),
  REDIS_URL: Type.Optional(Type.String({ minLength: 1 })),
  CORS_ORIGIN: Type.String({ minLength: 1 }),
});
type Env = Static<typeof EnvSchema>;

export interface Config {
  env: Env['NODE_ENV'];
  host: string;
  port: number;
  logLevel: Env['LOG_LEVEL'];
  db: { host: string; port: number; database: string; user: string; password: string; poolSize: number };
  /** Unset = Redis is not used (it is needed from Step 2.3). */
  redisUrl: string | undefined;
  /** CORS_ORIGIN, comma-separated. */
  corsOrigins: string[];
}

/** .env values, without overriding variables already set in the environment. */
function readEnvFile(): Record<string, string | undefined> {
  const file = join(API_ROOT, '.env');
  return existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {};
}

/**
 * Validates environment variables against a TypeBox object schema: .env values, overridden by
 * `environment`; empty values count as unset (except `keepEmpty`); defaults applied, strings
 * converted. Throws one error listing every problem. Modules use this for their own config.
 */
export function readEnvSchema<S extends TObject>(
  schema: S,
  environment: Record<string, string | undefined> = process.env,
  keepEmpty: string[] = [],
): Static<S> {
  const raw: Record<string, unknown> = { ...readEnvFile(), ...environment };
  for (const key of Object.keys(raw)) if (raw[key] === '' && !keepEmpty.includes(key)) delete raw[key];

  const env = Value.Default(schema, Value.Convert(schema, Value.Clean(schema, raw)));
  if (!Value.Check(schema, env)) {
    const problems = [...Value.Errors(schema, env)].map((e) => `${e.instancePath.slice(1) || '(root)'} ${e.message}`);
    throw new Error(`invalid configuration (see .env.example): ${problems.join('; ')}`);
  }
  return env;
}

export function loadConfig(environment: Record<string, string | undefined> = process.env): Config {
  const env = readEnvSchema(EnvSchema, environment, ['DB_PASSWORD']);

  return {
    env: env.NODE_ENV,
    host: env.HOST,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    db: {
      host: env.DB_HOST,
      port: env.DB_PORT,
      database: env.DB_NAME,
      user: env.DB_USER,
      password: env.DB_PASSWORD,
      poolSize: env.DB_POOL_SIZE,
    },
    redisUrl: env.REDIS_URL,
    corsOrigins: env.CORS_ORIGIN.split(',')
      .map((o) => o.trim())
      .filter(Boolean),
  };
}
