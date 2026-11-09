import { describe, expect, it } from 'vitest'
import { formatDifferenceTable } from '../../src/modules/family/services/mirror/reconcile.js'
import { parseReconcileArgs, reconcileReportPath } from '../../scripts/reconcile.js'

describe('reconcile arguments', () => {
  it('reads a child id and the fix flag', () => {
    expect(parseReconcileArgs([])).toEqual({ fix: false })
    expect(parseReconcileArgs(['--child', '765'])).toEqual({ fix: false, childId: 765 })
    expect(parseReconcileArgs(['--child', '765', '--fix', '--admin', '3'])).toEqual({ fix: true, childId: 765, adminId: 3 })
    expect(() => parseReconcileArgs(['--fix'])).toThrow(/--child/)
    expect(() => parseReconcileArgs(['--child', '765', '--fix'])).toThrow(/--admin/)
    expect(() => parseReconcileArgs(['--admin', 'x'])).toThrow(/positive integer/)
    expect(() => parseReconcileArgs(['--child', '0'])).toThrow(/positive integer/)
    expect(() => parseReconcileArgs(['--write'])).toThrow(/Unknown argument/)
  })

  it('names the report for the local date', () => {
    expect(reconcileReportPath(new Date(2026, 10, 6))).toBe('results/reconcile-2026-11-06.json')
  })

  it('prints one row per difference', () => {
    const table = formatDifferenceTable([
      { child: 12, column: 'father_phone', stored: '111', derived: '222' },
    ])
    expect(table).toContain('father_phone')
    expect(table).toContain('"111"')
    expect(table).toContain('"222"')
  })
})
