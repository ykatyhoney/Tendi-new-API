// Linking a child (PLAN.md "Mirror and lock behavior", "React screens: Link child"): the preview of
// the 29 legacy parent columns before and after linking, link (children.family_id = the family)
// and unlink (back to NULL).
//
// Setting family_id fires trg_children_family_bu / _au, which write the 28 mirrored columns in the
// same statement; unlinking leaves every column as it is, and the child form owns them again.
// home_send_notification is not mirrored: the preview shows it unchanged.
//
// Lock order, as every family write: the family row, then the child row (link). Unlink locks the
// child row only, since setting family_id to NULL fires no mirror.

import { HttpError } from '../../../errors.ts';
import type { FamilyDb, Queryable } from '../db.ts';
import { insertAuditLogs } from '../repository/audit-logs.ts';
import { type ChildRow, findChild, parentSlots, rightsCounts, setChildFamily } from '../repository/children.ts';
import { type FamilyRow, findFamily } from '../repository/families.ts';
import { mirroredLegacyValues, PREVIEW_COLUMNS, storedLegacyValues } from '../repository/legacy.ts';
import type { LINK_WARNING_CODES } from '../schemas/values.ts';
import type { Staff } from './auth.ts';
import { conflictsAs409 } from './db-errors.ts';
import { activeFamily } from './families.ts';

interface LinkWarning {
  code: (typeof LINK_WARNING_CODES)[number];
  message: string;
}

/** The child, or 404. `forUpdate` locks the row. */
export async function existingChild(db: Queryable, childId: number, forUpdate = false): Promise<ChildRow> {
  const child = await findChild(db, childId, forUpdate);
  if (!child) throw new HttpError(404, `Child ${childId} not found`);
  return child;
}

const SLOT_LABELS = { father: 'father or step-father', mother: 'mother or step-mother' } as const;

/** What staff should check before linking `child` to `family`. */
async function linkWarnings(db: Queryable, family: FamilyRow, child: ChildRow): Promise<LinkWarning[]> {
  const warnings: LinkWarning[] = [];
  if (child.family_id !== null && child.family_id !== family.id) {
    warnings.push({
      code: 'linked_to_other_family',
      message: `Child ${child.id} is linked to family ${child.family_id}; linking it here moves it (force=move)`,
    });
  }
  const [slots, counts] = await Promise.all([parentSlots(db, family.id), rightsCounts(db, family.id, child.id)]);
  if (counts.rights === 0) {
    warnings.push({
      code: 'no_rights',
      message: `No member of family ${family.id} has rights for child ${child.id} yet; set them before linking`,
    });
  }
  for (const slot of ['father', 'mother'] as const) {
    const filled = slots.find((s) => s.slot === slot);
    if (!filled) {
      warnings.push({
        code: `no_${slot}`,
        message: `No active ${SLOT_LABELS[slot]} in family ${family.id}: the ${slot} columns will be empty`,
      });
    } else if (!filled.has_primary_phone) {
      warnings.push({
        code: 'no_primary_phone',
        message: `The ${slot} (${filled.name || `member ${filled.member_id}`}) has no primary phone: ${slot}_phone will be empty`,
      });
    }
  }
  if (counts.payment_responsible === 0) {
    warnings.push({
      code: 'no_payment_responsible',
      message: `No member is payment-responsible for child ${child.id}: parent_email comes from the primary member (empty without one)`,
    });
  }
  return warnings;
}

/** The 29 columns now and once linked to `family`, with the warnings (LinkPreview). */
async function buildPreview(db: Queryable, family: FamilyRow, child: ChildRow) {
  const [stored, mirrored, warnings] = await Promise.all([
    storedLegacyValues(db, child.id),
    mirroredLegacyValues(db, child.id, family.id),
    linkWarnings(db, family, child),
  ]);
  if (!stored) throw new HttpError(404, `Child ${child.id} not found`);
  const columns = PREVIEW_COLUMNS.map(({ name, table, mirrored: isMirrored }) => {
    const current = stored[name];
    const afterLink = isMirrored ? (mirrored[name] ?? null) : current;
    return {
      column: name,
      table,
      mirrored: isMirrored,
      current,
      after_link: afterLink,
      changed: current !== afterLink,
    };
  });
  return { child_id: child.id, family_id: family.id, linked_family_id: child.family_id, columns, warnings };
}

/** GET /families/:id/children/:childId/preview. */
export async function previewLink(db: FamilyDb, familyId: number, childId: number) {
  return conflictsAs409(async () => {
    const family = await activeFamily(db.pool, familyId);
    const child = await existingChild(db.pool, childId);
    return buildPreview(db.pool, family, child);
  });
}

/**
 * POST /families/:id/children/:childId/link. The child must be unlinked (or `force: 'move'` from
 * another family) and have at least one rights row of an active member of the family. Returns the
 * preview read after the link, inside the transaction: every mirrored column now shows changed false.
 */
export async function linkChild(db: FamilyDb, staff: Staff, familyId: number, childId: number, force?: 'move') {
  // invalidateChildCaches([childId]) belongs after this commit once it exists: none is needed
  // today (docs/CONTEXT.md, "Invalidation").
  return conflictsAs409(() =>
    db.transaction(
      async (conn) => {
        const family = await activeFamily(conn, familyId, true);
        const child = await existingChild(conn, childId, true);
        if (child.family_id === familyId) {
          throw new HttpError(409, `Child ${childId} is already linked to family ${familyId}`);
        }
        if (child.family_id !== null && force !== 'move') {
          throw new HttpError(
            409,
            `Child ${childId} is linked to family ${child.family_id}; send force=move to move it to family ${familyId}`,
          );
        }
        if ((await rightsCounts(conn, familyId, childId)).rights === 0) {
          throw new HttpError(
            409,
            `Child ${childId} has no rights rows in family ${familyId}; set the members' rights for the child before linking`,
          );
        }
        await setChildFamily(conn, childId, familyId);
        await insertAuditLogs(conn, staff.adminId, [
          {
            table: 'children',
            tableId: childId,
            action: 'link',
            column: 'family_id',
            oldValue: child.family_id === null ? null : String(child.family_id),
            newValue: String(familyId),
            entityName: `Family ${family.name}: child ${childId}`,
          },
        ]);
        return buildPreview(conn, family, { ...child, family_id: familyId });
      },
      { auditUser: staff.adminId },
    ),
  );
}

/** POST /children/:childId/unlink: family_id back to NULL; the 29 columns keep their values. */
export async function unlinkChild(db: FamilyDb, staff: Staff, childId: number) {
  // invalidateChildCaches([childId]) belongs after this commit once it exists (see linkChild).
  return conflictsAs409(() =>
    db.transaction(
      async (conn) => {
        const child = await existingChild(conn, childId, true);
        if (child.family_id === null) throw new HttpError(409, `Child ${childId} is not linked to a family`);
        const family = await findFamily(conn, child.family_id);
        await setChildFamily(conn, childId, null);
        await insertAuditLogs(conn, staff.adminId, [
          {
            table: 'children',
            tableId: childId,
            action: 'unlink',
            column: 'family_id',
            oldValue: String(child.family_id),
            newValue: null,
            entityName: `Family ${family?.name ?? child.family_id}: child ${childId}`,
          },
        ]);
        return { child_id: childId, family_id: null };
      },
      { auditUser: staff.adminId },
    ),
  );
}
