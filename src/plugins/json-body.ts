import type { FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'
import secureJsonParse from 'secure-json-parse'

/**
 * Fastify rejects a zero-length application/json body before the route runs.
 * Link and unlink take no body, and clients still send that content type.
 * An empty body becomes {}. Invalid JSON and prototype keys stay a 400.
 */
const jsonBodyPlugin: FastifyPluginAsync = async (app) => {
  app.removeContentTypeParser('application/json')
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
    const text = typeof body === 'string' ? body : body.toString('utf8')
    if (text.length === 0) {
      done(null, {})
      return
    }
    try {
      done(null, secureJsonParse(text, { protoAction: 'error', constructorAction: 'error' }))
    } catch {
      done(
        Object.assign(new Error("Body is not valid JSON but content-type is set to 'application/json'"), {
          statusCode: 400,
        }),
      )
    }
  })
}

export default fp(jsonBodyPlugin, { name: 'family-json-body' })
