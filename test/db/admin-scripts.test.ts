import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { importDump, loadAdminConfig, runSql } from '../../scripts/mariadb-admin.js'

/*
 * The reset and schema scripts run the mariadb client. These check what they report when the client refuses to
 * sign in, which is the usual first-run mistake (DB_ADMIN_PASSWORD not set). Nothing is imported or changed:
 * the account below does not exist, so the client exits before it reads a statement.
 */

const refused = { ...loadAdminConfig(), user: 'no_such_admin_account', password: 'not-a-password' }

describe('the mariadb client scripts', () => {
  it('report the sign-in failure and the hint when a statement cannot run', async () => {
    await expect(runSql(refused, null, 'SELECT 1')).rejects.toThrow(/Access denied[\s\S]*Set DB_ADMIN_PASSWORD/)
  })

  it('report the same when an import stops before the dump is read', async () => {
    // The client exits while the dump is still being piped in. That broken pipe must not hide the real error
    // (it used to end the script as an uncaught EPIPE).
    await expect(
      importDump(refused, 'tendi_family_test', resolve('db/tendi-family-dev-db-2026-11-09.sql')),
    ).rejects.toThrow(/Access denied[\s\S]*Set DB_ADMIN_PASSWORD/)
  })
})
