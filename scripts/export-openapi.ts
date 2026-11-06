import { mkdirSync, writeFileSync } from 'node:fs'
import { buildApp } from '../src/app.js'
import { loadConfig } from '../src/config/env.js'

const config = await loadConfig()
const app = await buildApp({ config, logger: false })
await app.ready()
const document = app.swagger()
mkdirSync('openapi', { recursive: true })
writeFileSync('openapi/family.json', `${JSON.stringify(document, null, 2)}\n`)
await app.close()
console.log('Wrote openapi/family.json')
