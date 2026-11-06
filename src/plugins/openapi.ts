import type { FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'
import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'

const openapiPlugin: FastifyPluginAsync = async (app) => {
  await app.register(swagger, {
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
    await app.register(swaggerUi, { routePrefix: '/docs' })
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
    if (schema.security === undefined) {
      schema.security = route.url === '/api/v1/health' ? [] : [{ bearerAuth: [] }]
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
