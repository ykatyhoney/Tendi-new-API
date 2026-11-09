import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import fp from 'fastify-plugin'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import { errorBody } from '../lib/api-error.js'
import { readBearerToken } from '../lib/bearer.js'
import { tokenHash } from '../lib/token-hash.js'

const PER_MINUTE = 300

/*
 * Both limits keep their counters in this process's memory. With more than one API instance,
 * each instance counts on its own; pass a shared store (for example Redis) to @fastify/rate-limit then.
 * request.ip is the client only when TRUST_PROXY names the proxy in front of the API.
 */

const securityPlugin: FastifyPluginAsync = async (app) => {
  await app.register(helmet)
  await app.register(cors, {
    origin: [...app.config.corsOrigins],
  })
  await app.register(rateLimit, {
    global: true,
    max: PER_MINUTE,
    timeWindow: '1 minute',
    nameSpace: 'ip',
    keyGenerator: (request) => request.ip,
    errorResponseBuilder: () =>
      errorBody(429, 'RATE_LIMIT', 'Too many requests from this address. Try again in a minute.'),
  })

  const limitByToken = app.createRateLimit({
    max: PER_MINUTE,
    timeWindow: '1 minute',
    // The hash, so raw tokens are never kept as keys in the limiter's store.
    keyGenerator: (request) => {
      const token = bearerToken(request)
      return token === undefined ? 'token:none' : `token:${tokenHash(token)}`
    },
    allowList: (request) => bearerToken(request) === undefined,
  })

  app.addHook('onRequest', async (request, reply) => {
    const result = await limitByToken(request)
    if ('isExceeded' in result && result.isExceeded) {
      return sendRateLimit(reply)
    }
    return undefined
  })

  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id)
  })
}

function bearerToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization
  return readBearerToken(typeof header === 'string' ? header : undefined)
}

function sendRateLimit(reply: FastifyReply) {
  return reply
    .code(429)
    .send(errorBody(429, 'RATE_LIMIT', 'Too many requests for this token. Try again in a minute.'))
}

export default fp(securityPlugin, { name: 'family-security' })
