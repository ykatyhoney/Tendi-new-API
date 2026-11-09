import type { FastifyError, FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'
import sensible from '@fastify/sensible'
import { ApiError, errorBody, statusText } from '../lib/api-error.js'
import { mapDatabaseError, RETRY_AFTER_SECONDS } from '../lib/db-errors.js'
import { validationDetails } from '../lib/validator.js'
import type { ErrorObject } from 'ajv'

const errorsPlugin: FastifyPluginAsync = async (app) => {
  await app.register(sensible)

  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send(errorBody(404, 'NOT_FOUND', `Route ${request.method} ${request.url} was not found`))
  })

  app.setErrorHandler((caught, request, reply) => {
    const error = asHttpError(caught)
    const validation = validationErrors(error)
    if (validation !== undefined) {
      return reply.status(400).send(errorBody(400, 'VALIDATION', 'Validation failed', validation))
    }

    if (error instanceof ApiError) {
      if (error.code === 'RETRY') {
        reply.header('Retry-After', String(RETRY_AFTER_SECONDS))
      }
      return reply
        .status(error.statusCode)
        .send(errorBody(error.statusCode, error.code, error.message, error.details))
    }

    const databaseError = mapDatabaseError(error)
    if (databaseError !== null) {
      request.log.warn({ err: error, requestId: request.id }, 'database constraint rejected the write')
      if (databaseError.code === 'RETRY') {
        reply.header('Retry-After', String(RETRY_AFTER_SECONDS))
      }
      return reply.status(databaseError.statusCode).send(databaseError)
    }

    const statusCode = httpStatus(error)
    if (statusCode >= 500) {
      request.log.error({ err: error, requestId: request.id }, 'request failed')
    }
    const message = statusCode >= 500 ? 'Internal server error' : error.message
    return reply.status(statusCode).send(errorBody(statusCode, errorCode(error, statusCode), message))
  })
}

function asHttpError(error: unknown): FastifyError {
  if (typeof error === 'object' && error !== null) {
    return error as FastifyError
  }
  return Object.assign(new Error('Internal server error'), { statusCode: 500, code: 'INTERNAL' })
}

function validationErrors(error: FastifyError): { path: string; message: string }[] | undefined {
  if (!Array.isArray(error.validation) || error.validation.length === 0) {
    return undefined
  }
  return validationDetails(error.validation as ErrorObject[])
}

function httpStatus(error: FastifyError): number {
  if (typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 600) {
    return error.statusCode
  }
  return 500
}

function errorCode(error: FastifyError, statusCode: number): string {
  if (statusCode === 429) {
    return 'RATE_LIMIT'
  }
  if (typeof error.code === 'string' && error.code.length > 0 && !error.code.startsWith('ER_') && !error.code.startsWith('FST_')) {
    return error.code
  }
  if (statusCode === 404) {
    return 'NOT_FOUND'
  }
  return statusCode >= 500 ? 'INTERNAL' : statusText(statusCode).replaceAll(' ', '_').toUpperCase()
}

export default fp(errorsPlugin, { name: 'family-errors' })
