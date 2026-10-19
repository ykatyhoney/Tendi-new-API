// One JSON error format for every error response: { statusCode, error, message }.
// 5xx messages are replaced by the generic text (details go to the log only).

import { STATUS_CODES } from 'node:http';
import Type from 'typebox';
import type { FastifyError, FastifyInstance } from 'fastify';

export const ErrorResponse = Type.Object(
  {
    statusCode: Type.Integer(),
    error: Type.String(),
    message: Type.String(),
  },
  { $id: 'ErrorResponse', description: 'Error response, used by every route' },
);

export function errorBody(statusCode: number, message: string) {
  return { statusCode, error: STATUS_CODES[statusCode] ?? 'Error', message };
}

export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const statusCode = error.statusCode !== undefined && error.statusCode >= 400 ? error.statusCode : 500;
    if (statusCode >= 500) request.log.error({ err: error }, 'request failed');
    reply.status(statusCode).send(errorBody(statusCode, statusCode >= 500 ? 'Internal Server Error' : error.message));
  });

  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send(errorBody(404, `Route ${request.method} ${request.url} not found`));
  });
}
