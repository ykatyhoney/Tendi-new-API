import type { FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'
import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'
import { apiErrorSchema } from '../lib/api-error.js'
import { addValidatorSchemas } from '../lib/validator.js'
import { registeredModels } from '../modules/family/schemas/index.js'

const ERROR_REF = { $ref: 'ApiError#' }

const openapiPlugin: FastifyPluginAsync = async (app) => {
  // Shared before any route is added, so every route's 4xx and 5xx response can reference it.
  app.addSchema(apiErrorSchema)
  // The named models (schemas/models.ts): components.schemas in the document, $ref targets for the serializer,
  // and for the request validator, which is a custom compiler and does not see fastify's shared schemas.
  const models = registeredModels()
  for (const schema of models) {
    app.addSchema(schema)
  }
  addValidatorSchemas(models)

  await app.register(swagger, {
    // Name shared schemas by their $id, so the document has components/schemas/ApiError, not def-0.
    refResolver: {
      buildLocalReference(json, _baseUri, _fragment, index) {
        return typeof json['$id'] === 'string' ? json['$id'] : `def-${index}`
      },
    },
    openapi: {
      openapi: '3.0.3',
      info: {
        title: 'Family API',
        version: '0.1.0',
      },
      tags: [{ name: 'family', description: 'Family module' }],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
          },
        },
      },
      security: [{ bearerAuth: [] }],
    },
  })

  if (app.config.nodeEnv !== 'production') {
    await app.register(swaggerUi, {
      routePrefix: '/docs',
      uiConfig: {
        // The default (1) folds every field of a model to [...], so types were hidden until clicked open.
        defaultModelExpandDepth: 3,
        // Show how long each Try it out request took.
        displayRequestDuration: true,
        // Keep the Authorize token across reloads (the test site's sign-in cookie expires after 12 hours).
        persistAuthorization: true,
      },
    })
  }

  app.addHook('onRoute', (route) => {
    if (!route.url.startsWith('/api/')) {
      return
    }
    const schema = route.schema ?? {}
    if (schema.tags === undefined) {
      schema.tags = ['family']
    }
    if (schema.operationId === undefined && typeof route.method === 'string') {
      schema.operationId = operationId(route.method, route.url)
    }
    // Every error goes through the one error handler, so every route documents the same error body.
    const response = (schema.response ?? {}) as Record<string, unknown>
    response['4xx'] ??= ERROR_REF
    response['5xx'] ??= ERROR_REF
    schema.response = response
    if (schema.security === undefined) {
      schema.security = route.url.startsWith('/api/v1/health') ? [] : [{ bearerAuth: [] }]
    }
    route.schema = schema
  })
}

function operationId(method: string, url: string): string {
  const path = url
    .split('/')
    .filter((part) => part.length > 0 && !part.startsWith(':'))
    .map((part) => part.replace(/[^A-Za-z0-9]/g, ''))
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('')
  return method.toLowerCase() + path
}

export default fp(openapiPlugin, { name: 'family-openapi' })
