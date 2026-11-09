import { type FastifySchemaCompiler } from 'fastify'
import { Ajv, type AnySchema, type ErrorObject } from 'ajv'
import addFormats from 'ajv-formats'

const sharedOptions = {
  allErrors: true,
  removeAdditional: false,
  strict: false,
  useDefaults: true,
} as const

const bodyValidator = makeAjv(false)
const queryValidator = makeAjv(true)
const addedSchemas = new Set<string>()

/**
 * Shared schemas that route schemas reference with $ref (the named models). Fastify adds its shared schemas only to
 * its own Ajv, not to a custom validator compiler, so they are added here. Safe to call once per app instance.
 */
export function addValidatorSchemas(schemas: readonly object[]): void {
  for (const schema of schemas) {
    const id = (schema as { $id?: unknown }).$id
    if (typeof id !== 'string' || addedSchemas.has(id)) {
      continue
    }
    bodyValidator.addSchema(schema as AnySchema)
    queryValidator.addSchema(schema as AnySchema)
    addedSchemas.add(id)
  }
}

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
