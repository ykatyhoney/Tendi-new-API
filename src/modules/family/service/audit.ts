// The audit trail of Family API writes (PLAN.md "Security, permissions and audit"; backend CLAUDE.md
// rule 5). Every family write route builds its rows here and writes them with writeAudit on its
// transaction's connection, so they commit or roll back with the change itself.
//
// One audit_logs row per changed column: type 'family_api', action insert | update | delete |
// link | unlink, table_name / table_id the row, col_name, old_value / new_value as text,
// user_id = the staff member (request.staff.adminId), actor_type 'admin', entity_name a readable
// label ("Family Katz", "Person Avi Katz"). A column whose value does not change gets no row:
// columnChanges compares the text forms, and writeAudit drops any row whose old and new values are
// equal, whoever built it.
//
// Values as text: NULL stays NULL, booleans are '1' / '0' (the tinyint(1) flags), numbers and
// dates ('YYYY-MM-DD') as their string. So a stored tinyint 1 and a request's true are equal.

import type { Queryable } from '../db.ts';
import { type AuditAction, type AuditChange, insertAuditLogs } from '../repository/audit-logs.ts';
import type { Staff } from './auth.ts';

export type { AuditAction, AuditChange };

/** Which row the audit rows describe. */
export interface AuditTarget {
  table: string;
  tableId: number;
  entityName: string;
}

/** A column value as audit_logs stores it. */
export function auditValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value ? '1' : '0';
  return String(value);
}

/** A row's column values (a repository row, a request's values, a Partial of either). */
type Values = object;

const valueOf = (values: Values | null, column: string) => (values as Record<string, unknown> | null)?.[column];

/**
 * One row per column whose value differs between `before` and `after` (null = no row: an insert
 * has no before, a delete no after). `columns` defaults to the keys of `after` (else `before`).
 */
export function columnChanges(
  target: AuditTarget,
  action: AuditAction,
  before: Values | null,
  after: Values | null,
  columns: readonly string[] = Object.keys(after ?? before ?? {}),
): AuditChange[] {
  return columns.flatMap((column) => {
    const oldValue = auditValue(valueOf(before, column));
    const newValue = auditValue(valueOf(after, column));
    return oldValue === newValue ? [] : [{ ...target, action, column, oldValue, newValue }];
  });
}

/** Writes the rows, leaving out unchanged values, as the staff member, on the write's connection. */
export async function writeAudit(conn: Queryable, staff: Staff, changes: AuditChange[]): Promise<void> {
  await insertAuditLogs(
    conn,
    staff.adminId,
    changes.filter((c) => c.oldValue !== c.newValue),
  );
}
