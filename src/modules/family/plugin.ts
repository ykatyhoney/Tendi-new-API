import type { FastifyPluginAsync } from 'fastify'
import childRoutes from './routes/children.js'
import contactRoutes from './routes/contacts.js'
import familyRoutes from './routes/families.js'
import healthRoutes from './routes/health.js'
import relationshipTypeRoutes from './routes/relationship-types.js'

export interface FamilyModuleOptions {
  /** Registered inside the staff-auth boundary. Tests use this for guarded routes. */
  extraRoutes?: FastifyPluginAsync
}

/**
 * Family routes. Health stays open. Every other route in this plugin requires a staff token.
 */
const familyModule: FastifyPluginAsync<FamilyModuleOptions> = async (app, options) => {
  app.addHook('preHandler', async (request, reply) => {
    if (request.routeOptions.url === '/api/v1/health') {
      return
    }
    await app.authenticate(request, reply)
  })

  await app.register(healthRoutes)
  await app.register(familyRoutes)
  await app.register(contactRoutes)
  await app.register(childRoutes)
  await app.register(relationshipTypeRoutes)
  if (options.extraRoutes !== undefined) {
    await app.register(options.extraRoutes)
  }
}

export default familyModule
