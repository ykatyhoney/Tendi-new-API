import { Type } from '@fastify/type-provider-typebox'
import { model } from './models.js'

/** GET /api/v1/health: the pool answers and the family tables are there. */
export const healthResponse = model(
  'Health',
  Type.Object(
    {
      status: Type.Literal('ok'),
      database: Type.Literal('ready'),
    },
    { additionalProperties: false },
  ),
)

/** GET /api/v1/health/live: the process is up (no database). */
export const liveResponse = model('Liveness', Type.Object({ status: Type.Literal('ok') }, { additionalProperties: false }))
