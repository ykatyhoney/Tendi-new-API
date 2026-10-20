// Family members: add (an existing or a new person), edit, remove (status trash, never a delete).
// Writes run in familyDb.transaction with @audit_user = the staff member, lock the family row first
// (so member writes to one family run one at a time), add audit_logs rows, and return a warning when
// the mirror changed linked children's legacy values (service/mirror-watch.ts).
//
// At most one active primary member per family: making a member primary clears the flag on every
// other active member (the mirror uses the primary member for parent_email when nobody is
// payment-responsible), with an audit row for each.

import { HttpError } from '../../../errors.ts';
import type { FamilyDb, Queryable } from '../db.ts';
import { type AuditChange, insertAuditLogs } from '../repository/audit-logs.ts';
import { addressesOf, type FamilyRow, memberWithPerson, phonesOf } from '../repository/families.ts';
import { linkedChildIdsOfFamily } from '../repository/legacy.ts';
import {
  findMember,
  findMembershipForUpdate,
  insertMember,
  type MembershipRow,
  type MemberValues,
  otherPrimaryMembers,
  type RightFlags,
  rightsOfMemberForUpdate,
  updateRights,
  updateMember as updateMemberRow,
} from '../repository/members.ts';
import { insertPerson, type PersonValues } from '../repository/people.ts';
import type { Staff } from './auth.ts';
import { activeFamily } from './families.ts';
import { watchLegacy, withMirrorWarning } from './mirror-watch.ts';
import { activePerson, memberView, personName } from './people.ts';
import { defaultLegacyName } from './validation.ts';

const ER_DUP_ENTRY = 1062;

const auditValue = (v: string | number | boolean | null) =>
  v === null ? null : String(typeof v === 'boolean' ? Number(v) : v);

async function loadMember(db: Queryable, memberId: number) {
  const member = await memberWithPerson(db, memberId);
  const [phones, addresses] = await Promise.all([
    phonesOf(db, [member.person_id]),
    addressesOf(db, [member.person_id]),
  ]);
  return memberView(member, phones, addresses);
}

const conflict = (personId: number, family: FamilyRow, memberId?: number) =>
  new HttpError(
    409,
    `Person ${personId} is already a member of family ${family.id}${memberId ? ` (member ${memberId})` : ''}`,
  );

/** Clears is_primary on the family's other active members; their audit rows. */
async function clearOtherPrimaries(conn: Queryable, family: FamilyRow, memberId: number): Promise<AuditChange[]> {
  const others = await otherPrimaryMembers(conn, family.id, memberId);
  for (const id of others) await updateMemberRow(conn, id, { is_primary: 0 });
  return others.map((id) => memberAudit(family, id, 'update', 'is_primary', '1', '0'));
}

const memberAudit = (
  family: FamilyRow,
  memberId: number,
  action: AuditChange['action'],
  column: string,
  oldValue: string | null,
  newValue: string | null,
): AuditChange => ({
  table: 'family_members',
  tableId: memberId,
  action,
  column,
  oldValue,
  newValue,
  entityName: `Family ${family.name}`,
});

/** The member columns PATCH may change, compared with the stored row; their audit rows. */
function memberChanges(family: FamilyRow, before: MembershipRow, edit: MemberEdit) {
  const changes: Partial<MemberValues> = {};
  if (edit.relationship !== undefined && edit.relationship !== before.relationship)
    changes.relationship = edit.relationship;
  if (edit.is_primary !== undefined && Number(edit.is_primary) !== before.is_primary)
    changes.is_primary = Number(edit.is_primary);
  if (edit.sort_order !== undefined && edit.sort_order !== before.sort_order) changes.sort_order = edit.sort_order;
  const audit = (Object.keys(changes) as (keyof MemberValues)[]).map((c) =>
    memberAudit(family, before.id, 'update', c, auditValue(before[c]), auditValue(changes[c] ?? null)),
  );
  return { changes, audit };
}

/** What a restored member's rights become for every child: staff set them again explicitly. */
const RIGHTS_RESET: RightFlags = {
  receives_notifications: 0,
  may_collect: 0,
  collect_from: null,
  collect_to: null,
  is_emergency: 0,
  is_payment_responsible: 0,
};

/** Resets the member's rights rows (RIGHTS_RESET); an audit row per changed column per row. */
async function resetRights(conn: Queryable, family: FamilyRow, memberId: number): Promise<AuditChange[]> {
  const audit: AuditChange[] = [];
  const changedIds: number[] = [];
  for (const right of await rightsOfMemberForUpdate(conn, memberId)) {
    const columns = (Object.keys(RIGHTS_RESET) as (keyof RightFlags)[]).filter((c) => right[c] !== RIGHTS_RESET[c]);
    if (columns.length > 0) changedIds.push(right.id);
    for (const column of columns) {
      audit.push({
        table: 'family_member_children',
        tableId: right.id,
        action: 'update',
        column,
        oldValue: auditValue(right[column]),
        newValue: auditValue(RIGHTS_RESET[column]),
        entityName: `Family ${family.name}: child ${right.child_id}`,
      });
    }
  }
  await updateRights(conn, changedIds, RIGHTS_RESET);
  return audit;
}

export interface MemberEdit {
  relationship?: string;
  is_primary?: boolean;
  sort_order?: number;
}

export interface NewPerson {
  fname?: string;
  lname?: string;
  hebrew_name?: string;
  email?: string;
  note?: string | null;
  occupation?: string;
  employer?: string;
}

export interface AddMember extends MemberEdit {
  person_id?: number;
  person?: NewPerson;
  relationship: string;
}

/**
 * POST /families/:id/members. uniq_fm allows a person once per family: an active membership is a
 * 409; a trashed one (a member removed earlier) is restored with the new values, and its rights
 * rows (kept while trashed) are reset for every child, so staff set the rights again explicitly.
 */
export async function addMember(db: FamilyDb, staff: Staff, familyId: number, input: AddMember) {
  const { body, affected, status } = await db.transaction(
    async (conn) => {
      const family = await activeFamily(conn, familyId, true);
      const watch = await watchLegacy(conn, await linkedChildIdsOfFamily(conn, familyId));
      const audit: AuditChange[] = [];
      const wanted = {
        relationship: input.relationship,
        is_primary: input.is_primary ?? false,
        sort_order: input.sort_order ?? 0,
      };

      let personId: number;
      let existing: MembershipRow | null = null;
      if (input.person_id !== undefined) {
        personId = (await activePerson(conn, input.person_id, true)).id;
        existing = await findMembershipForUpdate(conn, familyId, personId);
        if (existing?.status === 'active') throw conflict(personId, family, existing.id);
      } else {
        const p = input.person ?? {};
        // A new person's legacy name is always "fname lname" (see service/people.ts updatePerson).
        const values: PersonValues = {
          fname: p.fname ?? '',
          lname: p.lname ?? '',
          legacy_full_name: defaultLegacyName(p),
          hebrew_name: p.hebrew_name ?? '',
          email: p.email ?? '',
          note: p.note ?? null,
          occupation: p.occupation ?? '',
          employer: p.employer ?? '',
        };
        personId = await insertPerson(conn, values, staff.adminId);
        const set = [...Object.keys(p), 'legacy_full_name'] as (keyof PersonValues)[];
        for (const column of new Set(set)) {
          audit.push({
            table: 'people',
            tableId: personId,
            action: 'create',
            column,
            oldValue: null,
            newValue: values[column],
            entityName: `Person ${personName(values)}`,
          });
        }
      }

      let memberId: number;
      if (existing) {
        memberId = existing.id;
        const { changes, audit: rows } = memberChanges(family, existing, wanted);
        await updateMemberRow(conn, memberId, { ...changes, status: 'active' });
        audit.push(memberAudit(family, memberId, 'update', 'status', 'trash', 'active'), ...rows);
        audit.push(...(await resetRights(conn, family, memberId)));
      } else {
        try {
          memberId = await insertMember(conn, { family_id: familyId, person_id: personId, ...wanted });
        } catch (error) {
          if ((error as { errno?: number }).errno === ER_DUP_ENTRY) throw conflict(personId, family);
          throw error;
        }
        audit.push(
          ...Object.entries({ person_id: personId, ...wanted }).map(([column, value]) =>
            memberAudit(family, memberId, 'create', column, null, auditValue(value)),
          ),
        );
      }
      if (wanted.is_primary) audit.push(...(await clearOtherPrimaries(conn, family, memberId)));

      await insertAuditLogs(conn, staff.adminId, audit);
      return {
        body: await loadMember(conn, memberId),
        affected: await watch.changed(),
        status: (existing ? 200 : 201) as 200 | 201,
      };
    },
    { auditUser: staff.adminId },
  );
  return { status, body: withMirrorWarning(body, affected) };
}

/** An active member of an active family, both locked, or 404. */
async function activeMember(conn: Queryable, familyId: number, memberId: number) {
  const family = await activeFamily(conn, familyId, true);
  const member = await findMember(conn, familyId, memberId, true);
  if (!member || member.status !== 'active') {
    throw new HttpError(404, `Member ${memberId} of family ${familyId} not found`);
  }
  return { family, member };
}

/** PATCH /families/:id/members/:memberId. */
export async function updateMember(db: FamilyDb, staff: Staff, familyId: number, memberId: number, edit: MemberEdit) {
  const { body, affected } = await db.transaction(
    async (conn) => {
      const { family, member } = await activeMember(conn, familyId, memberId);
      const watch = await watchLegacy(conn, await linkedChildIdsOfFamily(conn, familyId));
      const { changes, audit } = memberChanges(family, member, edit);
      await updateMemberRow(conn, memberId, changes);
      if (edit.is_primary === true) audit.push(...(await clearOtherPrimaries(conn, family, memberId)));
      await insertAuditLogs(conn, staff.adminId, audit);
      return { body: await loadMember(conn, memberId), affected: await watch.changed() };
    },
    { auditUser: staff.adminId },
  );
  return withMirrorWarning(body, affected);
}

/**
 * DELETE /families/:id/members/:memberId: status = 'trash', never a row delete. The member's
 * rights rows stay, ignored while the member is trashed (by the mirror, the detail and the search);
 * adding the person back resets them (addMember).
 */
export async function removeMember(db: FamilyDb, staff: Staff, familyId: number, memberId: number) {
  const { body, affected } = await db.transaction(
    async (conn) => {
      const { family } = await activeMember(conn, familyId, memberId);
      const watch = await watchLegacy(conn, await linkedChildIdsOfFamily(conn, familyId));
      await updateMemberRow(conn, memberId, { status: 'trash' });
      await insertAuditLogs(conn, staff.adminId, [
        memberAudit(family, memberId, 'delete', 'status', 'active', 'trash'),
      ]);
      return { body: await loadMember(conn, memberId), affected: await watch.changed() };
    },
    { auditUser: staff.adminId },
  );
  return withMirrorWarning(body, affected);
}
