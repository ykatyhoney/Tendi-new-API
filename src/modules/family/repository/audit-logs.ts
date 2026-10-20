// SQL for the audit_logs rows of Family API writes. The rules (one row per changed column, the
// value format) are in service/audit.ts, which every write route goes through.
// type = 'family_api', actor_type = 'admin', actor_ref = 'family-api', device_id NULL;
// created_at / updated_at come from the column defaults (the database clock).

import type { Queryable } from '../db.ts';

export type AuditAction = 'insert' | 'update' | 'delete' | 'link' | 'unlink';

export interface AuditChange {
  table: string;
  tableId: number;
  action: AuditAction;
  column: string;
  oldValue: string | null;
  newValue: string | null;
  entityName: string;
}

export const AUDIT_TYPE = 'family_api';

export async function insertAuditLogs(db: Queryable, adminId: number, changes: AuditChange[]): Promise<void> {
  if (changes.length === 0) return;
  await db.query(
    `INSERT INTO audit_logs (type, table_name, action, col_name, old_value, new_value, user_id, actor_type, actor_ref,
                             table_id, entity_name)
     VALUES ?`,
    [
      changes.map((c) => [
        AUDIT_TYPE,
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
