import { Type, type Static, type TSchema, type TUnsafe } from '@fastify/type-provider-typebox'

/*
 * Named models. model('Family', schema) registers the schema once under that name and returns a { $ref: 'Family#' }
 * to use in routes and in other schemas. The OpenAPI document lists every model under components.schemas, so
 * Swagger shows it under Schemas and a generated client gets a type per model.
 *
 * The models are added to fastify (Swagger and the response serializer) and to the request validator's Ajv in
 * plugins/openapi.ts. Query strings and path params stay inline: Swagger turns them into separate parameters.
 */

const DEFINITION = Symbol('model definition')

/** A $ref to a named model. Static types come from the definition, which definitionOf() returns. */
export type Model<T extends TSchema> = TUnsafe<Static<T>> & { readonly [DEFINITION]: T }

const registry = new Map<string, TSchema>()

export function model<T extends TSchema>(name: string, schema: T): Model<T> {
  if (registry.has(name)) {
    throw new Error(`Model ${name} is defined twice.`)
  }
  registry.set(name, { ...schema, $id: name } as TSchema)
  const ref = Type.Unsafe<Static<T>>({ $ref: `${name}#` })
  // Not enumerable, so JSON, Ajv, the serializer and Swagger see only the $ref.
  Object.defineProperty(ref, DEFINITION, { value: schema, enumerable: false })
  return ref as Model<T>
}

/** The schema a model was defined with (tests read field limits from it). */
export function definitionOf<T extends TSchema>(ref: Model<T>): T {
  return ref[DEFINITION]
}

/** Every model, each with its $id. Schema modules register on import; see schemas/index.ts. */
export function registeredModels(): TSchema[] {
  return [...registry.values()]
}
