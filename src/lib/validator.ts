import { type FastifySchemaCompiler } from 'fastify'
import { Ajv, type ErrorObject } from 'ajv'
import addFormats from 'ajv-formats'

const sharedOptions = {
  allErrors: true,
  removeAdditional: false,
  strict: false,
  useDefaults: true,
} as const

const bodyValidator = makeAjv(false)
const queryValidator = makeAjv(true)

/**
 * Ajv for every route. Query, params, and headers are coerced. The body is not.
 * removeAdditional stays off so a client cannot silently drop fields.
 */
export const ajvValidatorCompiler: FastifySchemaCompiler<Record<string, unknown>> = ({ schema, httpPart }) => {
  const validate = (httpPart === 'body' ? bodyValidator : queryValidator).compile(schema)
  return (data) => {
    if (validate(data)) {
      return { value: data }
    }
    return { error: validate.errors ?? [] }
  }
}

export function validationDetails(errors: readonly ErrorObject[]): { path: string; message: string }[] {
  return errors.map((error) => ({
    path: fieldPath(error),
    message: error.message ?? 'is invalid',
  }))
}

function fieldPath(error: ErrorObject): string {
  const missing = error.params['missingProperty']
  if (typeof missing === 'string') {
    return error.instancePath.length > 0 ? `${error.instancePath}/${missing}` : `/${missing}`
  }
  return error.instancePath.length > 0 ? error.instancePath : '/'
}

function makeAjv(coerceTypes: boolean): Ajv {
  const ajv = new Ajv({
    ...sharedOptions,
    coerceTypes,
  })
  const applyFormats = addFormats as unknown as (instance: Ajv) => Ajv
  applyFormats(ajv)
  return ajv
}
