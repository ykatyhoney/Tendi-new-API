// Rights per child (PUT /families/:id/children/:childId/rights): the full set of the family's
// members' rights for one child. Each listed member must be an active member of the family; their
// row is inserted or updated (uniq_fmc: one per member and child). Rows of active members missing
// from the list are deleted. A removed (trashed) member's rows are kept: they are ignored while the
// member is trashed and reset when the member is added back (service/members.ts).
//
// Runs in familyDb.transaction, locking the family row first like every member write, with an
// audit row per changed column. When the child is linked to this family, the mirror triggers
// rewrite its legacy columns in the same transaction and the response carries the mirror warning.

import { HttpError } from '../../../errors.ts';
import type { FamilyDb } from '../db.ts';
import type { FamilyRow } from '../repository/families.ts';
import {
  activeMemberIds,
  deleteRights,
  insertRight,
  RIGHT_COLUMNS,
  type RightValues,
  rightsOfChild,
  rightsOfChildForUpdate,
  updateRight,
} from '../repository/rights.ts';
import { type AuditChange, type AuditTarget, columnChanges, writeAudit } from './audit.ts';
import type { Staff } from './auth.ts';
import { conflictsAs409 } from './db-errors.ts';
import { activeFamily, rightView } from './families.ts';
import { existingChild } from './link.ts';
import { watchLegacy, withMirrorWarning } from './mirror-watch.ts';

export interface ChildRightInput {
  member_id: number;
  is_primary?: boolean;
  receives_notifications?: boolean;
  notify_method?: string;
  may_collect?: boolean;
  collect_from?: string | null;
  collect_to?: string | null;
  is_emergency?: boolean;
  is_payment_responsible?: boolean;
}

const rightValues = (r: ChildRightInput): RightValues => ({
  is_primary: Number(r.is_primary ?? false),
  receives_notifications: Number(r.receives_notifications ?? false),
  notify_method: r.notify_method ?? 'sms',
  may_collect: Number(r.may_collect ?? false),
  collect_from: r.collect_from ?? null,
  collect_to: r.collect_to ?? null,
  is_emergency: Number(r.is_emergency ?? false),
  is_payment_responsible: Number(r.is_payment_responsible ?? false),
});

/** The audit target of a family_member_children row. */
export const rightTarget = (family: FamilyRow, right: { id: number; child_id: number }): AuditTarget => ({
  table: 'family_member_children',
  tableId: right.id,
  entityName: `Family ${family.name}: child ${right.child_id}`,
});

export async function setChildRights(
  db: FamilyDb,
  staff: Staff,
  familyId: number,
  childId: number,
  rights: ChildRightInput[],
) {
  const { body, affected } = await conflictsAs409(() =>
    db.transaction(
      async (conn) => {
        const family = await activeFamily(conn, familyId, true);
        const child = await existingChild(conn, childId);
        const watch = await watchLegacy(conn, child.family_id === familyId ? [childId] : []);

        const members = await activeMemberIds(
          conn,
          familyId,
          rights.map((r) => r.member_id),
        );
        rights.forEach((r, i) => {
          if (!members.has(r.member_id)) {
            throw new HttpError(
              409,
              `rights/${i}/member_id: ${r.member_id} is not an active member of family ${familyId}`,
            );
          }
        });

        const audit: AuditChange[] = [];
        const existing = await rightsOfChildForUpdate(conn, familyId, childId);
        const listed = new Set(rights.map((r) => r.member_id));
        const removed = existing.filter((r) => r.member_status === 'active' && !listed.has(r.member_id));
        await deleteRights(
          conn,
          removed.map((r) => r.id),
        );
        for (const r of removed) {
          audit.push(...columnChanges(rightTarget(family, r), 'delete', r, null, ['member_id', ...RIGHT_COLUMNS]));
        }

        const byMember = new Map(existing.map((r) => [r.member_id, r]));
        for (const input of rights) {
          const values = rightValues(input);
          const before = byMember.get(input.member_id);
          if (!before) {
            const after = { member_id: input.member_id, child_id: childId, ...values };
            const id = await insertRight(conn, input.member_id, childId, values);
            audit.push(...columnChanges(rightTarget(family, { id, child_id: childId }), 'insert', null, after));
            continue;
          }
          const rows = columnChanges(rightTarget(family, before), 'update', before, values);
          await updateRight(
            conn,
            before.id,
            Object.fromEntries(rows.map((r) => [r.column, values[r.column as keyof RightValues]])),
          );
          audit.push(...rows);
        }

        await writeAudit(conn, staff, audit);
        return {
          body: { rights: (await rightsOfChild(conn, familyId, childId)).map(rightView) },
          affected: await watch.changed(),
        };
      },
      { auditUser: staff.adminId },
    ),
  );
  return withMirrorWarning(body, affected);
}
