import fastifyEnv from '@fastify/env'
import { Type } from '@fastify/type-provider-typebox'
import Fastify from 'fastify'

const nodeEnvSchema = Type.Union(
  [Type.Literal('development'), Type.Literal('test'), Type.Literal('production')],
  { default: 'development' },
)

const logLevelSchema = Type.Union(
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
)

/** Variables validated at startup. Listed in .env.example. */
export const envSchema = Type.Object({
  NODE_ENV: nodeEnvSchema,
  PORT: Type.Integer({ minimum: 0, maximum: 65535, default: 3000 }),
  HOST: Type.String({ minLength: 1, default: '127.0.0.1' }),
  DB_HOST: Type.String({ minLength: 1, default: '127.0.0.1' }),
  DB_PORT: Type.Integer({ minimum: 0, maximum: 65535, default: 3306 }),
  DB_NAME: Type.String({ minLength: 1, default: 'tendi_family_dev' }),
  FAMILY_DB_USER: Type.String({ minLength: 1, default: 'family_api' }),
  FAMILY_DB_PASSWORD: Type.String({ default: '' }),
  DB_POOL_SIZE: Type.Integer({ minimum: 1, maximum: 100, default: 10 }),
  CORS_ORIGIN: Type.String({ default: 'http://127.0.0.1:3001' }),
  ALLOWED_STAFF_TYPES: Type.String({ default: 'admin,office' }),
  RELATIONSHIP_ADMIN_TYPES: Type.String({ default: 'admin,superadmin' }),
  LOG_LEVEL: logLevelSchema,
})

export type RawEnv = Type.Static<typeof envSchema>
export type NodeEnv = RawEnv['NODE_ENV']
export type LogLevel = RawEnv['LOG_LEVEL']

export interface AppConfig {
  nodeEnv: NodeEnv
  port: number
  host: string
  logLevel: LogLevel
  db: {
    host: string
    port: number
    name: string
    user: string
    password: string
    poolSize: number
  }
  corsOrigins: readonly string[]
  allowedStaffTypes: readonly string[]
  relationshipAdminTypes: readonly string[]
}

export interface LoadConfigOptions {
  /** When false, process.env is ignored. Tests use this. */
  env?: boolean
  /** When false, .env is not read. */
  dotenv?: boolean
  data?: Record<string, unknown>
}

const LOCAL_DB_HOSTS = new Set(['127.0.0.1', 'localhost'])

export function assertLocalDatabaseHost(env: Pick<RawEnv, 'NODE_ENV' | 'DB_HOST'>): void {
  if (env.NODE_ENV === 'production') {
    return
  }
  if (!LOCAL_DB_HOSTS.has(env.DB_HOST)) {
    throw new Error(
      `DB_HOST must be 127.0.0.1 or localhost when NODE_ENV is ${env.NODE_ENV}. Refusing to start against ${env.DB_HOST}.`,
    )
  }
}

function requireList(name: string, value: string): string[] {
  const items = value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
  if (items.length === 0) {
    throw new Error(`${name} must list at least one value`)
  }
  return items
}

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
}

export function toAppConfig(env: RawEnv): AppConfig {
  return {
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    host: env.HOST,
    logLevel: env.LOG_LEVEL,
    db: {
      host: env.DB_HOST,
      port: env.DB_PORT,
      name: env.DB_NAME,
      user: env.FAMILY_DB_USER,
      password: env.FAMILY_DB_PASSWORD,
      poolSize: env.DB_POOL_SIZE,
    },
    corsOrigins: splitList(env.CORS_ORIGIN),
    allowedStaffTypes: requireList('ALLOWED_STAFF_TYPES', env.ALLOWED_STAFF_TYPES),
    relationshipAdminTypes: requireList('RELATIONSHIP_ADMIN_TYPES', env.RELATIONSHIP_ADMIN_TYPES),
  }
}

export async function loadConfig(options: LoadConfigOptions = {}): Promise<AppConfig> {
  const app = Fastify({ logger: false })
  try {
    await app.register(fastifyEnv, {
      schema: envSchema,
      dotenv: options.dotenv ?? true,
      env: options.env ?? true,
      ...(options.data === undefined ? {} : { data: options.data }),
    })
    const raw = app.getEnvs<RawEnv>()
    assertLocalDatabaseHost(raw)
    return toAppConfig(raw)
  } finally {
    await app.close()
  }
}
