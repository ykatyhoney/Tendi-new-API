import type { Pool, PoolConnection } from 'mysql2/promise'
import { describe, expect, it } from 'vitest'
import { withStaffTransaction, withTransaction } from '../../src/lib/with-transaction.js'

interface FakeConnection {
  statements: string[]
  released: boolean
  destroyed: boolean
}

function fakePool(options: { failReset?: boolean; deadlocks?: number } = {}) {
  const connections: FakeConnection[] = []
  let deadlocks = options.deadlocks ?? 0
  const pool = {
    async getConnection() {
      const state: FakeConnection = { statements: [], released: false, destroyed: false }
      connections.push(state)
      const connection = {
        async query(sql: string) {
          state.statements.push(sql)
          if (options.failReset === true && sql.startsWith('SET @family_mirror = NULL')) {
            throw new Error('connection lost')
          }
          if (sql === 'WORK' && deadlocks > 0) {
            deadlocks -= 1
            throw Object.assign(new Error('deadlock'), { errno: 1213 })
          }
          return [[], []]
        },
        async beginTransaction() {
          state.statements.push('BEGIN')
        },
        async commit() {
          state.statements.push('COMMIT')
        },
        async rollback() {
          state.statements.push('ROLLBACK')
        },
        release() {
          state.released = true
        },
        destroy() {
          state.destroyed = true
        },
      }
      return connection as unknown as PoolConnection
    },
  }
  return { pool: pool as unknown as Pool, connections }
}

describe('withTransaction', () => {
  it('runs at READ COMMITTED, then clears the session variables and releases', async () => {
    const { pool, connections } = fakePool()
    await withTransaction(pool, async (connection) => {
      await connection.query('WORK')
    })
    expect(connections[0]?.statements).toEqual([
      'SET TRANSACTION ISOLATION LEVEL READ COMMITTED',
      'BEGIN',
      'WORK',
      'COMMIT',
      'SET @family_mirror = NULL, @audit_user = NULL',
    ])
    expect(connections[0]).toMatchObject({ released: true, destroyed: false })
  })

  it('destroys a connection whose session variables could not be cleared', async () => {
    const { pool, connections } = fakePool({ failReset: true })
    await withTransaction(pool, async (connection) => {
      await connection.query('WORK')
    })
    expect(connections[0]).toMatchObject({ released: false, destroyed: true })
  })

  it('retries once on a deadlock with a fresh connection', async () => {
    const { pool, connections } = fakePool({ deadlocks: 1 })
    await withTransaction(pool, async (connection) => {
      await connection.query('WORK')
    })
    expect(connections).toHaveLength(2)
    expect(connections[0]?.statements).toContain('ROLLBACK')
    expect(connections.every((connection) => connection.released)).toBe(true)
  })

  it('sets the audit user for a staff write', async () => {
    const { pool, connections } = fakePool()
    await withStaffTransaction(pool, 42, async () => undefined)
    expect(connections[0]?.statements).toContain('SET @audit_user = ?')
  })
})

describe('logic fixes: withTransaction', () => {
  it('F15 destroys the connection instead of releasing it when ROLLBACK fails', async () => {
    const state = { released: false, destroyed: false }
    const connection = {
      async query() {
        return [[], []]
      },
      async beginTransaction() {},
      async commit() {},
      async rollback() {
        throw new Error('rollback refused')
      },
      release() {
        state.released = true
      },
      destroy() {
        state.destroyed = true
      },
    }
    const pool = { getConnection: async () => connection as unknown as PoolConnection } as unknown as Pool
    await expect(
      withTransaction(pool, async () => {
        throw new Error('work failed')
      }),
    ).rejects.toThrow('work failed')
    expect(state).toEqual({ released: false, destroyed: true })
  })
})
