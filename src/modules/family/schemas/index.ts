/*
 * Loads every schema module, so each named model is registered before plugins/openapi.ts adds them to fastify and
 * to the request validator. A new schema module that defines models must be imported here.
 */
import './common.js'
import './child.js'
import './contact.js'
import './family.js'
import './health.js'
import './link.js'
import './relationship-type.js'
import './staff.js'

export { registeredModels } from './models.js'
