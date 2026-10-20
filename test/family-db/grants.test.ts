// family_api (scripts/family/grants.sql): exactly the listed privileges, no write access to any
// legacy column, and still a working write path because the mirror runs as its definer.
// Connects as family_api to tendi_family_test; every test is rolled back.

import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import type { Connection, RowDataPacket } from 'mysql2/promise';
import { connectLocal, loadEnv, requireEnv } from '../../scripts/family/lib/db.ts';

let db: Connection;
let database: string;

before(async () => {
  loadEnv();
  database = requireEnv('DB_TEST_NAME');
  db = await connectLocal(database, { user: requireEnv('FAMILY_DB_USER'), password: requireEnv('FAMILY_DB_PASSWORD') });
});
beforeEach(() => db.beginTransaction());
afterEach(() => db.rollback());
after(() => db.end());

const errno = (error: unknown) => (error as { errno?: number }).errno;

async function denied(sql: string, expectedErrno: number, params: unknown[] = []) {
  await assert.rejects(db.query(sql, params), (error) => errno(error) === expectedErrno, sql);
}

async function anyChild(): Promise<number> {
  const [[row]] = await db.query<RowDataPacket[]>(`
    SELECT c.id FROM children c JOIN children_additional_information cai ON cai.child_id = c.id
     WHERE c.status = 'active' AND c.family_id IS NULL ORDER BY c.id LIMIT 1`);
  return row.id;
}

describe('family_api grants', () => {
  test('holds exactly the privileges in grants.sql', async () => {
    const [rows] = await db.query<RowDataPacket[]>('SHOW GRANTS');
    const grants = rows
      .map((r) => String(Object.values(r)[0]))
      .filter((g) => g.includes(`\`${database}\``))
      .map((g) => g.replace(/ TO .*$/, '').replace(`\`${database}\`.`, ''))
      .sort();
    const family = ['families', 'people', 'family_members', 'people_phones', 'people_addresses', 'family_member_children'];
    assert.deepEqual(
      grants,
      [
        ...family.map((t) => `GRANT SELECT, INSERT, UPDATE, DELETE ON \`${t}\``),
        'GRANT SELECT ON `admin`',
        'GRANT SELECT ON `admin_api_tokens`',
        'GRANT SELECT ON `children_additional_information`',
        'GRANT SELECT, UPDATE (`family_id`) ON `children`',
        'GRANT INSERT ON `audit_logs`',
        'GRANT EXECUTE ON PROCEDURE `sp_family_preview`',
      ].sort(),
    );
  });

  test('cannot write any legacy parent column, the lock log or the mirror procedures', async () => {
    const child = await anyChild();
    await denied('UPDATE children SET father_phone = ? WHERE id = ?', 1143, ['000', child]);
    await denied('UPDATE children SET parent_email = ? WHERE id = ?', 1143, ['x@example.test', child]);
    await denied('UPDATE children SET home_send_notification = 1 WHERE id = ?', 1143, [child]);
    await denied('UPDATE children_additional_information SET father_email = ? WHERE child_id = ?', 1142, ['x', child]);
    await denied(
      "INSERT INTO family_mirror_lock_log (child_id, table_name, col_name, db_user) VALUES (1, 'children', 'x', 'x')",
      1142,
    );
    await denied('CALL sp_family_mirror(?)', 1370, [child]);
    await denied('CALL sp_family_mirror_values(?, NULL, @a,@b,@c,@d,@e,@f,@g,@h,@i,@j,@k,@l,@m,@n,@o,@p,@q,@r,@s,@t,@u,@v,@w,@x,@y,@z,@aa,@bb)', 1370, [child]);
    await denied('DELETE FROM audit_logs WHERE id = 0', 1142);
    await denied('SELECT COUNT(*) FROM family_reconcile_runs', 1142);
  });

  test('can still link a child: the mirror (run as its definer) fills the legacy columns', async () => {
    const child = await anyChild();
    await db.query('SET @audit_user = 1');
    const [f] = await db.query(`INSERT INTO families (name, household_phone, created_at, updated_at, created_by, updated_by)
                                VALUES ('Grants', '718-555-0101', NOW(), NOW(), 1, 1)`);
    const familyId = (f as { insertId: number }).insertId;
    const [p] = await db.query(`INSERT INTO people (fname, lname, legacy_full_name, email, created_at, updated_at, created_by, updated_by)
                                VALUES ('Avi', 'Grants', 'Avi Grants', 'avi.grants@example.test', NOW(), NOW(), 1, 1)`);
    const personId = (p as { insertId: number }).insertId;
    await db.query("INSERT INTO people_phones (person_id, phone, phone_normalized, is_primary) VALUES (?, '347-555-0177', '3475550177', 1)", [personId]);
    const [m] = await db.query("INSERT INTO family_members (family_id, person_id, relationship, is_primary) VALUES (?, ?, 'father', 1)", [familyId, personId]);
    await db.query(
      "INSERT INTO family_member_children (member_id, child_id, receives_notifications, notify_method, is_payment_responsible) VALUES (?, ?, 1, 'sms', 1)",
      [(m as { insertId: number }).insertId, child],
    );

    const [[preview]] = (await db.query<RowDataPacket[][]>('CALL sp_family_preview(?, ?)', [child, familyId]))[0];
    assert.equal(preview.father_name, 'Avi Grants');

    await db.query('UPDATE children SET family_id = ? WHERE id = ?', [familyId, child]);
    const [[row]] = await db.query<RowDataPacket[]>('SELECT father_name, father_phone, parent_email FROM children WHERE id = ?', [child]);
    assert.deepEqual({ ...row }, { father_name: 'Avi Grants', father_phone: '347-555-0177', parent_email: 'avi.grants@example.test' });

    const [audit] = await db.query("INSERT INTO audit_logs (type, table_name, action, user_id, actor_type, table_id) VALUES ('family', 'children', 'link', 1, 'admin', ?)", [child]);
    assert.equal((audit as { affectedRows: number }).affectedRows, 1);
  });
});
