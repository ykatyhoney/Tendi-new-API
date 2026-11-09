import type { FastifyPluginAsync } from 'fastify'
import childRoutes from './routes/children.js'
import contactRoutes from './routes/contacts.js'
import familyRoutes from './routes/families.js'
import healthRoutes from './routes/health.js'
import linkRoutes from './routes/links.js'
import relationshipTypeRoutes from './routes/relationship-types.js'

export interface FamilyModuleOptions {
  /** Registered inside the staff-auth boundary. Tests use this for guarded routes. */
  extraRoutes?: FastifyPluginAsync
}

/**
 * Family routes. Health is registered outside the staff-auth scope.
 * Every other route requires a staff token, checked in onRequest so an unauthenticated
 * request is refused before its body is parsed or validated.
 */
const familyModule: FastifyPluginAsync<FamilyModuleOptions> = async (app, options) => {
  await app.register(healthRoutes)

  await app.register(async (staffScope) => {
    staffScope.addHook('onRequest', async (request, reply) => {
      await staffScope.authenticate(request, reply)
    })

    await staffScope.register(familyRoutes)
    await staffScope.register(contactRoutes)
    await staffScope.register(childRoutes)
    await staffScope.register(linkRoutes)
    await staffScope.register(relationshipTypeRoutes)
    if (options.extraRoutes !== undefined) {
      await staffScope.register(options.extraRoutes)
    }
  })
}

export default familyModule
