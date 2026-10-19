// The single place a drift alert leaves the reconciliation job.
// Alerting/email is not set up in this backend yet (CONTEXT.md), so today the alert is a warning
// on stderr; the CLI also exits with code 2, which makes the OS scheduler record the run as
// failed. When an alerting channel is chosen, send it from here.

import type { ReconcileResult } from './run.ts';

export function alertDrift(runId: number, database: string, result: ReconcileResult): void {
  const columns = new Map<string, number>();
  for (const child of result.drifted) for (const c of child.columns) columns.set(c.column, (columns.get(c.column) ?? 0) + 1);
  console.warn([
    `WARNING family reconcile run ${runId} (${database}): ${result.driftedChildren} of ${result.linkedChildren} linked children drifted.`,
    `  children: ${result.drifted.map((d) => d.childId).join(', ')}`,
    columns.size > 0 ? `  columns: ${[...columns].map(([c, n]) => `${c} (${n})`).join(', ')}` : '',
    result.drifted.some((d) => d.error) ? `  preview errors: ${result.drifted.filter((d) => d.error).map((d) => d.childId).join(', ')}` : '',
    '  Nothing was changed. Details: SELECT details FROM family_reconcile_runs WHERE id = ' + runId + ';',
  ].filter(Boolean).join('\n'));
}
