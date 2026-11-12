import { Writable } from 'node:stream'
import pino from 'pino'
import { describe, expect, it } from 'vitest'
import { loggerOptions } from '../../src/app.js'

/** A logger with these options whose lines are kept in memory. */
function capture(nodeEnv: 'test' | 'production') {
  const lines: string[] = []
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      lines.push(chunk.toString('utf8'))
      done()
    },
  })
  return { logger: pino(loggerOptions({ logLevel: 'info', nodeEnv }), stream), output: () => lines.join('') }
}

/** What mysql2 throws: `sql` is the statement with its values filled in. */
function failedInsert() {
  return Object.assign(new Error("Duplicate entry '7' for key 'uq_fcp_primary'"), {
    code: 'ER_DUP_ENTRY',
    errno: 1062,
    sqlMessage: "Duplicate entry '7' for key 'uq_fcp_primary'",
    sql: "INSERT INTO family_contact_phones (family_contact_id, phone) VALUES (7, '(718) 555-0142')",
  })
}

describe('server logs', () => {
  it('leave the statement, which holds contact details, out of production logs', () => {
    const production = capture('production')
    production.logger.warn({ err: failedInsert() }, 'database constraint rejected the write')
    const line = production.output()
    expect(line).not.toContain('555-0142')
    expect(line).not.toContain('INSERT INTO')
    // What went wrong, and where, is still there.
    expect(line).toContain('uq_fcp_primary')
    expect(line).toContain('1062')
    expect(line).toContain('logger.test')
  })

  it('keep the statement outside production, for debugging', () => {
    const test = capture('test')
    test.logger.warn({ err: failedInsert() }, 'database constraint rejected the write')
    expect(test.output()).toContain('INSERT INTO family_contact_phones')
  })

  it('never hold the bearer token, a cookie, or a password', () => {
    for (const nodeEnv of ['test', 'production'] as const) {
      const { logger, output } = capture(nodeEnv)
      logger.info(
        {
          req: { headers: { authorization: 'Bearer staff-secret-token', cookie: 'gate=cookie-secret' } },
          db: { password: 'database-secret', token_hash: 'hash-secret' },
          token: 'top-level-secret',
        },
        'request',
      )
      for (const secret of ['staff-secret-token', 'cookie-secret', 'database-secret', 'hash-secret', 'top-level-secret']) {
        expect(output(), `${nodeEnv}: ${secret}`).not.toContain(secret)
      }
    }
  })
})
