export class ApiError extends Error {
  readonly statusCode: number
  readonly code: string
  readonly details?: unknown

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message)
    this.name = 'ApiError'
    this.statusCode = statusCode
    this.code = code
    this.details = details
  }
}

export interface ApiErrorBody {
  statusCode: number
  code: string
  error: string
  message: string
  details?: unknown
}

const STATUS_TEXT: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
}

export function statusText(statusCode: number): string {
  return STATUS_TEXT[statusCode] ?? (statusCode >= 500 ? 'Internal Server Error' : 'Error')
}

export function errorBody(
  statusCode: number,
  code: string,
  message: string,
  details?: unknown,
): ApiErrorBody {
  const body: ApiErrorBody = {
    statusCode,
    code,
    error: statusText(statusCode),
    message,
  }
  if (details !== undefined) {
    body.details = details
  }
  return body
}
