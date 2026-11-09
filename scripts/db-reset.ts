import { resolve } from 'node:path'
import { databaseNameForTarget, RESET_DATABASES } from '../src/lib/database-target.js'
import { clearDatabaseCache } from './clear-cache.js'
import { ensureFamilyApi, importDump, loadAdminConfig, loadRedisUrl, recreateDatabase, runSql } from './mariadb-admin.js'

const targetFlag = process.argv.indexOf('--target')
const target = targetFlag === -1 ? '' : process.argv[targetFlag + 1] ?? ''
const database = databaseNameForTarget(target)
const config = loadAdminConfig()
const dumpPath = resolve('db/tendi-family-dev-db-2026-11-09.sql')

console.log(`Recreating ${database} on ${config.host} from the November 9 dump (revision 4).`)
await recreateDatabase(config, database)
await importDump(config, database, dumpPath)

const existing = await runSql(
  config,
  null,
  `SELECT DISTINCT table_schema FROM information_schema.tables
   WHERE table_name = 'family_contacts'
     AND table_schema IN ('${RESET_DATABASES.dev}', '${RESET_DATABASES.test}')`,
)
const databases = existing
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line.length > 0)

await ensureFamilyApi(config, databases)
console.log(`Imported ${database} and granted family_api on ${databases.join(', ')}.`)

const redisUrl = loadRedisUrl()
if (redisUrl !== null) {
  const removed = await clearDatabaseCache(redisUrl, database)
  console.log(`Cleared ${removed} cached entr${removed === 1 ? 'y' : 'ies'} for ${database} in Redis.`)
}
