import { randomUUID } from 'node:crypto'
import { type TypeBoxTypeProvider } from '@fastify/type-provider-typebox'
import Fastify from 'fastify'
import pino, { type LoggerOptions } from 'pino'
import { configWarnings, type AppConfig } from './config/env.js'
import { ajvValidatorCompiler } from './lib/validator.js'
import familyModule, { type FamilyModuleOptions } from './modules/family/plugin.js'
import authPlugin from './plugins/auth.js'
import dbPlugin from './plugins/db.js'
import errorsPlugin from './plugins/errors.js'
import jsonBodyPlugin from './plugins/json-body.js'
import openapiPlugin from './plugins/openapi.js'
import redisPlugin from './plugins/redis.js'
import securityPlugin from './plugins/security.js'

declare module 'fastify' {
  interface FastifyInstance {
    config: AppConfig
  }
}

export interface BuildAppOptions {
  config: AppConfig
  /** Tests pass false so output stays quiet. The server uses a pino instance. */
  logger?: false
  /** Routes registered behind staff auth. Tests use this; the server does not. */
  extraRoutes?: FamilyModuleOptions['extraRoutes']
}

const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'password',
  '*.password',
  'token',
  '*.token',
  '*.token_hash',
]

/**
 * mysql2 puts the statement it ran on the error as `sql`, with the values already filled in: names, phones,
 * emails, addresses and notes. Production logs must not hold contact details, so it is left out there. The
 * error's message, number and stack stay. Development and test keep the statement for debugging.
 */
const PRODUCTION_REDACT_PATHS = ['err.sql']

/** The server's pino options. Exported for tests. */
export function loggerOptions(config: Pick<AppConfig, 'logLevel' | 'nodeEnv'>): LoggerOptions {
  return {
    level: config.logLevel,
    redact: config.nodeEnv === 'production' ? [...REDACT_PATHS, ...PRODUCTION_REDACT_PATHS] : REDACT_PATHS,
    // Readable lines on a developer's terminal; JSON everywhere else. pino-pretty is a dev dependency.
    ...(config.nodeEnv === 'development'
      ? { transport: { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' } } }
      : {}),
  }
}

/**
 * Builds the Family API without listening. Tests call this and use app.inject().
 * Health stays open. Other family routes require staff auth. Writes mirror linked children in the same transaction.
 */
export async function buildApp(options: BuildAppOptions) {
  const { config } = options
  const app = Fastify({
    bodyLimit: 100 * 1024,
    // false so genReqId always runs. With a header name set, Fastify uses the raw header
    // and calls genReqId only when the header is missing, which skips the check below.
    requestIdHeader: false,
    trustProxy: trustProxyOption(config.trustProxy),
    genReqId(request) {
      const header = request.headers['x-request-id']
      if (typeof header === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(header)) {
        return header
      }
      return randomUUID()
    },
    ...(options.logger === false
      ? { logger: false as const }
      : { loggerInstance: pino(loggerOptions(config)) }),
  })
    .setValidatorCompiler(ajvValidatorCompiler)
    .withTypeProvider<TypeBoxTypeProvider>()

  app.decorate('config', config)
  for (const warning of configWarnings(config)) {
    app.log.warn(warning)
  }
  await app.register(jsonBodyPlugin)
  await app.register(errorsPlugin)
  await app.register(redisPlugin)
  await app.register(securityPlugin)
  await app.register(openapiPlugin)
  await app.register(dbPlugin)
  await app.register(authPlugin)
  await app.register(familyModule, {
    ...(options.extraRoutes === undefined ? {} : { extraRoutes: options.extraRoutes }),
  })
  return app
}

/** A hop count trusts that many proxies in front of the API. Fastify's types take it as a function. */
function trustProxyOption(value: AppConfig['trustProxy']): boolean | string[] | ((address: string, hop: number) => boolean) {
  if (typeof value === 'number') {
    return (_address, hop) => hop < value
  }
  return value
}
