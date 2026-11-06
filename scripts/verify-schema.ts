import { resolve } from 'node:path'
import { RESET_DATABASES } from '../src/lib/database-target.js'
import { diffSchema } from '../src/lib/schema-diff.js'
import { importDump, loadAdminConfig, recreateDatabase } from './mariadb-admin.js'
import { readSchemaSnapshot } from './schema-snapshot.js'

const REFERENCE = 'tendi_family_schema_ref'
const config = loadAdminConfig()
const modulePath = resolve('db/tendi_family_module.sql')
const requested = process.argv.includes('--database')
  ? process.argv[process.argv.indexOf('--database') + 1]
  : undefined
const targets = requested ? [requested] : [RESET_DATABASES.dev, RESET_DATABASES.test]

console.log(`Building schema reference ${REFERENCE} from db/tendi_family_module.sql.`)
await recreateDatabase(config, REFERENCE)
await importDump(config, REFERENCE, modulePath)
const reference = await readSchemaSnapshot(config, REFERENCE)

let failed = false
for (const database of targets) {
  if (database !== RESET_DATABASES.dev && database !== RESET_DATABASES.test) {
    throw new Error(`--database must be ${RESET_DATABASES.dev} or ${RESET_DATABASES.test}.`)
  }
  const actual = await readSchemaSnapshot(config, database)
  const differences = diffSchema(actual, reference)
  if (differences.length === 0) {
    console.log(`${database}: ok (${actual.columns.length} columns, ${actual.lockTriggers.length} lock triggers)`)
    continue
  }
  failed = true
  console.error(`${database}: ${differences.length} difference(s)`)
  for (const difference of differences) {
    console.error(`  ${difference}`)
  }
}

if (failed) {
  process.exit(1)
}
