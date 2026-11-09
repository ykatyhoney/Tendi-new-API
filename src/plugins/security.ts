import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import fp from 'fastify-plugin'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import { Redis } from 'ioredis'
import { errorBody } from '../lib/api-error.js'
import { readBearerToken } from '../lib/bearer.js'
import { tokenHash } from '../lib/token-hash.js'

/*
 * Two limits, RATE_LIMIT_PER_MINUTE each: per IP, and per bearer token.
 * Without RATE_LIMIT_REDIS_URL the counters live in this process, so each API instance counts on its own.
 * With it, every instance shares one count in Redis. If Redis is unreachable the limits let requests
 * through (skipOnError) and log a warning, so a Redis outage does not take the API down.
 * request.ip is the client only when TRUST_PROXY names the proxy in front of the API.
 */

const REDIS_NAMESPACE = 'family-api-rate-limit:'

const securityPlugin: FastifyPluginAsync = async (app) => {
  const { perMinute, redisUrl } = app.config.rateLimit
  await app.register(helmet)
  await app.register(cors, {
    origin: [...app.config.corsOrigins],
  })

  const redis = redisUrl === null ? undefined : sharedRedis(redisUrl)
  if (redis !== undefined) {
    // An unhandled 'error' event would end the process. One warning per outage, not one per retry.
    // The URL can hold a password, so it is not logged.
    let down = false
    redis.on('error', (error: Error) => {
      if (!down) {
        down = true
        app.log.warn({ err: { message: error.message } }, 'rate-limit Redis is unavailable; limits are not enforced')
      }
    })
    redis.on('ready', () => {
      if (down) {
        down = false
        app.log.info('rate-limit Redis is reachable again')
      }
    })
    app.addHook('onClose', async () => {
      redis.disconnect()
    })
  }

  await app.register(rateLimit, {
    global: true,
    max: perMinute,
    timeWindow: '1 minute',
    ...(redis === undefined ? {} : { redis, nameSpace: REDIS_NAMESPACE, skipOnError: true }),
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
      return sendRateLimit(reply)
    }
    return undefined
  })

  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id)
  })
}

/** Fails fast while disconnected, so a request never waits on Redis; skipOnError then lets it through. */
function sharedRedis(url: string): Redis {
  return new Redis(url, {
    connectTimeout: 1000,
    commandTimeout: 500,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
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
