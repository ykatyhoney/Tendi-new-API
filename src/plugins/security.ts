import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import fp from 'fastify-plugin'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import { errorBody } from '../lib/api-error.js'
import { readBearerToken } from '../lib/bearer.js'
import { tokenHash } from '../lib/token-hash.js'
import { redisKeyPrefix } from './redis.js'

/*
 * Two limits, RATE_LIMIT_PER_MINUTE each: per IP, and per bearer token.
 * Without REDIS_URL the counters live in this process, so each API instance counts on its own.
 * With it, every instance shares one count in Redis (app.redis, from plugins/redis.ts). If Redis is
 * unreachable the limits let requests through (skipOnError), so a Redis outage does not take the API down.
 * request.ip is the client only when TRUST_PROXY names the proxy in front of the API.
 */

/** Every method a family route uses. */
export const CORS_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] as const

const securityPlugin: FastifyPluginAsync = async (app) => {
  const { perMinute } = app.config.rateLimit
  const redis = app.redis
  await app.register(helmet)
  await app.register(cors, {
    origin: [...app.config.corsOrigins],
    // @fastify/cors allows only GET, HEAD, and POST unless told otherwise, and browsers then
    // refuse every PATCH, PUT, and DELETE from Tendi-new after the preflight.
    methods: [...CORS_METHODS],
    allowedHeaders: ['authorization', 'content-type', 'x-request-id'],
    exposedHeaders: ['x-request-id', 'retry-after'],
    maxAge: 600,
  })

  await app.register(rateLimit, {
    global: true,
    max: perMinute,
    timeWindow: '1 minute',
    ...(redis === null ? {} : { redis, nameSpace: `${redisKeyPrefix(app.config.db.name)}rate-limit:`, skipOnError: true }),
    keyGenerator: (request) => `ip:${request.ip}`,
    errorResponseBuilder: () =>
      errorBody(429, 'RATE_LIMIT', 'Too many requests from this address. Try again in a minute.'),
  })

  const limitByToken = app.createRateLimit({
    max: perMinute,
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
      return sendRateLimit(reply, result.ttlInSeconds)
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

/** Retry-After as the per-IP limit sends it: the seconds until this token's window ends. */
function sendRateLimit(reply: FastifyReply, retryAfterSeconds: number) {
  if (retryAfterSeconds > 0) {
    reply.header('retry-after', retryAfterSeconds)
  }
  return reply
    .code(429)
    .send(errorBody(429, 'RATE_LIMIT', 'Too many requests for this token. Try again in a minute.'))
}

export default fp(securityPlugin, { name: 'family-security', dependencies: ['family-redis'] })
