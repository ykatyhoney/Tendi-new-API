// The 28 legacy parent columns the mirror owns (SCHEMA.md "The mirror owns 28 columns"), read for
// a before / after comparison, and the linked children a family edit can reach.

import type { RowDataPacket } from 'mysql2/promise';
import type { Queryable } from '../db.ts';

/** On children (10). Same names and order as the LegacyParentValues schema. */
export const MIRRORED_CHILDREN_COLUMNS = [
  'father_name',
  'mother_name',
  'father_phone',
  'mother_phone',
  'home_phone',
  'parent_email',
  'use_father_phone_for_notification',
  'use_mother_phone_for_notification',
  'notification_father_phone_method',
  'notification_mother_phone_method',
] as const;

/** On children_additional_information (18). */
export const MIRRORED_CAI_COLUMNS = (['father', 'mother'] as const).flatMap((parent) =>
  ['fname', 'lname', 'home_phone', 'email', 'address', 'occupation', 'employer', 'work_address', 'office_phone'].map(
    (column) => `${parent}_${column}`,
  ),
);

/** The 28 mirrored values of each child, as one comparable string per child id. */
export async function legacySnapshot(db: Queryable, childIds: number[]): Promise<Map<number, string>> {
  if (childIds.length === 0) return new Map();
  const columns = [...MIRRORED_CHILDREN_COLUMNS.map((c) => `c.${c}`), ...MIRRORED_CAI_COLUMNS.map((c) => `cai.${c}`)];
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT c.id AS child_id, ${columns.join(', ')}
       FROM children c
       LEFT JOIN children_additional_information cai ON cai.child_id = c.id
      WHERE c.id IN (?)`,
    [childIds],
  );
  // children_additional_information is unique on child_id (uniq_child): one row per child.
  return new Map(rows.map(({ child_id: id, ...values }) => [id as number, JSON.stringify(values)]));
}

/** Children linked to the family. */
export async function linkedChildIdsOfFamily(db: Queryable, familyId: number): Promise<number[]> {
  const [rows] = await db.query<RowDataPacket[]>('SELECT id FROM children WHERE family_id = ? ORDER BY id', [familyId]);
  return rows.map((r) => r.id);
}

/** Children linked to any family the person is (or was) a member of. */
export async function linkedChildIdsOfPerson(db: Queryable, personId: number): Promise<number[]> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT c.id FROM children c
      WHERE c.family_id IN (SELECT fm.family_id FROM family_members fm WHERE fm.person_id = ?)
      ORDER BY c.id`,
    [personId],
  );
  return rows.map((r) => r.id);
}
