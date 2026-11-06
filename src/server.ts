import { buildApp } from './app.js'
import { loadConfig } from './config/env.js'

const config = await loadConfig()
const app = await buildApp({ config })

try {
  await app.listen({ port: config.port, host: config.host })
} catch (error) {
  app.log.error(error)
  process.exit(1)
}
