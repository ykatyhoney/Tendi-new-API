import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { RESET_DATABASES } from '../src/lib/database-target.js'
import { diffSchema } from '../src/lib/schema-diff.js'
import { importDump, loadAdminConfig, recreateDatabase } from './mariadb-admin.js'
import { LOCK_TRIGGERS, readSchemaSnapshot } from './schema-snapshot.js'

const REFERENCE = 'tendi_family_schema_ref'
const REVISION = 'Revision 4'
// tendi_family_module.sql alters children and children_additional_information, so it can't be imported on
// its own. The reference is the 2026-09-24 tenant dump with that script already applied.
const MODULE_FILE = 'db/tendi_family_module.sql'
const REFERENCE_FILE = 'db/raul-tendi-db-2026-09-24_family.sql'
const config = loadAdminConfig()
const requested = process.argv.includes('--database')
  ? process.argv[process.argv.indexOf('--database') + 1]
  : undefined
const targets = requested ? [requested] : [RESET_DATABASES.dev, RESET_DATABASES.test]

const moduleHeader = readFileSync(resolve(MODULE_FILE), 'utf8').slice(0, 2000)
if (!moduleHeader.includes(REVISION)) {
  throw new Error(`${MODULE_FILE} is not ${REVISION}. Update this script together with the schema files.`)
}

console.log(`Building schema reference ${REFERENCE} from ${REFERENCE_FILE} (${MODULE_FILE}, ${REVISION}).`)
await recreateDatabase(config, REFERENCE)
await importDump(config, REFERENCE, resolve(REFERENCE_FILE))
const reference = await readSchemaSnapshot(config, REFERENCE)
const missingInReference = missingLockTriggers(reference.lockTriggers)
if (missingInReference.length > 0) {
  throw new Error(`${REFERENCE_FILE} is missing lock trigger(s): ${missingInReference.join(', ')}.`)
}

let failed = false
for (const database of targets) {
  if (database !== RESET_DATABASES.dev && database !== RESET_DATABASES.test) {
    throw new Error(`--database must be ${RESET_DATABASES.dev} or ${RESET_DATABASES.test}.`)
  }
  const actual = await readSchemaSnapshot(config, database)
  const differences = diffSchema(actual, reference)
  for (const name of missingLockTriggers(actual.lockTriggers)) {
    differences.push(`missing lock trigger ${name}`)
  }
  if (differences.length === 0) {
    console.log(
      `${database}: ok (${actual.columns.length} columns, ${actual.lockTriggers.length} lock triggers: ${LOCK_TRIGGERS.join(', ')})`,
    )
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

/** Snapshot rows start with the trigger name (see readSchemaSnapshot). */
function missingLockTriggers(rows: readonly string[]): string[] {
  return LOCK_TRIGGERS.filter((name) => !rows.some((row) => row.startsWith(`${name} `)))
}
