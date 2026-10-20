// audit_logs rows for Family API writes (backend CLAUDE.md rule 5), in the shape the PHP app's
// rows use: one row per changed column (col_name, old_value, new_value), type = the module,
// action = the verb, table_name / table_id = the row, entity_name = a readable label.
// created_at / updated_at come from the column defaults (the database clock).

import type { Queryable } from '../db.ts';

export interface AuditChange {
  table: string;
  tableId: number;
  action: 'create' | 'update' | 'delete' | 'link' | 'unlink';
  column: string;
  oldValue: string | null;
  newValue: string | null;
  entityName: string;
}

export async function insertAuditLogs(db: Queryable, adminId: number, changes: AuditChange[]): Promise<void> {
  if (changes.length === 0) return;
  await db.query(
    `INSERT INTO audit_logs (type, table_name, action, col_name, old_value, new_value, user_id, actor_type, actor_ref,
                             table_id, entity_name)
     VALUES ?`,
    [
      changes.map((c) => [
        'family',
        c.table,
        c.action,
        c.column,
        c.oldValue,
        c.newValue,
        adminId,
        'admin',
        'family-api',
        c.tableId,
        c.entityName.slice(0, 255),
      ]),
    ],
  );
}
