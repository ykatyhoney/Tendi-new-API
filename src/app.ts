import {
  TypeBoxValidatorCompiler,
  registerAjvFormats,
  type TypeBoxTypeProvider,
} from '@fastify/type-provider-typebox'
import Fastify from 'fastify'
import pino from 'pino'
import type { AppConfig } from './config/env.js'
import dbPlugin from './plugins/db.js'

declare module 'fastify' {
  interface FastifyInstance {
    config: AppConfig
  }
}

registerAjvFormats()

export interface BuildAppOptions {
  config: AppConfig
  /** Tests pass false so output stays quiet. The server uses a pino instance. */
  logger?: false
}

/**
 * Builds the Family API without listening. Tests call this and use app.inject().
 * Auth, routes, and OpenAPI are added in later steps.
 */
export async function buildApp(options: BuildAppOptions) {
  const { config } = options
  const app = Fastify(
    options.logger === false
      ? { logger: false }
      : {
          loggerInstance: pino({
            level: config.logLevel,
            redact: ['req.headers.authorization'],
          }),
        },
  )
    .setValidatorCompiler(TypeBoxValidatorCompiler)
    .withTypeProvider<TypeBoxTypeProvider>()

  app.decorate('config', config)
  await app.register(dbPlugin)
  return app
}
