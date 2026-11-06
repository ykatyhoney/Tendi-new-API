import { randomUUID } from 'node:crypto'
import { type TypeBoxTypeProvider } from '@fastify/type-provider-typebox'
import Fastify from 'fastify'
import pino from 'pino'
import type { AppConfig } from './config/env.js'
import { ajvValidatorCompiler } from './lib/validator.js'
import familyModule, { type FamilyModuleOptions } from './modules/family/plugin.js'
import authPlugin from './plugins/auth.js'
import dbPlugin from './plugins/db.js'
import errorsPlugin from './plugins/errors.js'
import openapiPlugin from './plugins/openapi.js'
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
 * Builds the Family API without listening. Tests call this and use app.inject().
 * Health stays open. Other family routes require staff auth. Family, member, and contact writes mirror linked children in the same transaction.
 */
export async function buildApp(options: BuildAppOptions) {
  const { config } = options
  const app = Fastify({
    bodyLimit: 100 * 1024,
    requestIdHeader: 'x-request-id',
    genReqId(request) {
      const header = request.headers['x-request-id']
      if (typeof header === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(header)) {
        return header
      }
      return randomUUID()
    },
    ...(options.logger === false
      ? { logger: false as const }
      : {
          loggerInstance: pino({
            level: config.logLevel,
            redact: REDACT_PATHS,
          }),
        }),
  })
    .setValidatorCompiler(ajvValidatorCompiler)
    .withTypeProvider<TypeBoxTypeProvider>()

  app.decorate('config', config)
  await app.register(errorsPlugin)
  await app.register(securityPlugin)
  await app.register(openapiPlugin)
  await app.register(dbPlugin)
  await app.register(authPlugin)
  await app.register(familyModule, {
    ...(options.extraRoutes === undefined ? {} : { extraRoutes: options.extraRoutes }),
  })
  return app
}
