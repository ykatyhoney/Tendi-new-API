import { describe, expect, it } from 'vitest'
import { describeError } from '../../src/status/checker.js'
import { emptyHistory, lastDays, record, uptime } from '../../src/status/history.js'
import { evaluate, PROBES, type Probe, type ProbeContext } from '../../src/status/probes.js'

const context: ProbeContext = {
  familyId: 7, familyName: 'Status', householdPhone: '', memberId: 3, memberSortOrder: 0, contactId: 5,
  contactNote: null, phones: [], emails: [], addresses: [], linkedChildId: 28, fatherSortOrder: 1,
}

function probe(id: string): Probe {
  const found = PROBES.find((entry) => entry.id === id)
  if (found === undefined) {
    throw new Error(`no probe ${id}`)
  }
  return found
}

describe('status probes', () => {
  it('cover every documented route and method of the API', async () => {
    const spec = (await import('../../openapi/family.json', { with: { type: 'json' } })).default as {
      paths: Record<string, Record<string, unknown>>
    }
    const documented = Object.entries(spec.paths).flatMap(([path, operations]) =>
      Object.keys(operations).map((method) => `${method.toUpperCase()} ${path}`),
    )
    const probed = new Set(PROBES.map((entry) => `${entry.method} ${entry.route}`))
    expect(documented.filter((route) => !probed.has(route))).toEqual([])
  })

  it('pass on the expected status and code, and say why when not', () => {
    expect(evaluate(probe('links-link'), { status: 409, body: { code: 'ALREADY_LINKED' } }, context)).toBeNull()
    expect(evaluate(probe('links-link'), { status: 200, body: {} }, context)).toBe('expected 409 ALREADY_LINKED, got 200')
    expect(evaluate(probe('links-link'), { status: 409, body: { code: 'SECOND_PRIMARY' } }, context)).toBe(
      'expected code ALREADY_LINKED, got SECOND_PRIMARY',
    )
  })

  it('fail a no-op save that reports changed children', () => {
    expect(evaluate(probe('families-patch'), { status: 200, body: { affected_child_ids: [] } }, context)).toBeNull()
    expect(evaluate(probe('families-patch'), { status: 200, body: { affected_child_ids: [28] } }, context)).toMatch(/affected_child_ids \[28\]/)
  })

  it('check that a search finds the status records', () => {
    expect(evaluate(probe('families-search'), { status: 200, body: { items: [{ id: 7 }] } }, context)).toBeNull()
    expect(evaluate(probe('families-search'), { status: 200, body: { items: [{ id: 8 }] } }, context)).toBe('the status household is missing')
  })
})

describe('status history', () => {
  it('counts each UTC day, works out uptime, and opens and closes an incident', () => {
    const history = emptyHistory()
    record(history, 'families-get', 'Get a family', { at: '2026-11-09T10:00:00.000Z', ok: true, ms: 20, status: 200, error: null })
    record(history, 'families-get', 'Get a family', { at: '2026-11-09T10:01:00.000Z', ok: false, ms: 5, status: 500, error: 'expected 200, got 500' })
    record(history, 'families-get', 'Get a family', { at: '2026-11-09T10:02:00.000Z', ok: false, ms: 5, status: 500, error: 'expected 200, got 500' })
    expect(history.incidents).toHaveLength(1)
    expect(history.incidents[0]).toMatchObject({ endedAt: null, failures: 2 })
    record(history, 'families-get', 'Get a family', { at: '2026-11-09T10:03:00.000Z', ok: true, ms: 1500, status: 200, error: null })
    expect(history.incidents[0]?.endedAt).toBe('2026-11-09T10:03:00.000Z')
    expect(history.checks['families-get']?.days['2026-11-09']).toEqual({ ok: 2, fail: 2, slow: 1, totalMs: 1530 })
    expect(uptime(history.checks['families-get'])).toBe(50)
    expect(uptime(undefined)).toBeNull()
  })

  it('keeps 90 days', () => {
    const history = emptyHistory()
    record(history, 'x', 'X', { at: '2026-01-01T00:00:00.000Z', ok: true, ms: 1, status: 200, error: null })
    record(history, 'x', 'X', { at: '2026-11-09T00:00:00.000Z', ok: true, ms: 1, status: 200, error: null })
    expect(Object.keys(history.checks['x']?.days ?? {})).toEqual(['2026-11-09'])
    const days = lastDays('2026-11-09T12:00:00.000Z', 90)
    expect(days).toHaveLength(90)
    expect(days.at(-1)).toBe('2026-11-09')
    expect(days[0]).toBe('2026-08-12')
  })
})

describe('status errors', () => {
  it('say why a request failed', () => {
    expect(describeError(new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } }))).toBe(
      'fetch failed: ECONNREFUSED (the API is not running)',
    )
    expect(describeError(Object.assign(new Error('aborted'), { name: 'TimeoutError' }))).toBe('no answer within 15 s')
    expect(describeError('plain')).toBe('plain')
  })
})
