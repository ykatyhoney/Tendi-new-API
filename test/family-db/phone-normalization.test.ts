// The SQL normalizer (families.household_phone_normalized, migration family_025) gives exactly what
// normalizePhone gives, on every normalizer unit-test input (test/support/phone-cases.ts).
// Read-only against tendi_family_test, plus inserts that are rolled back.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { Connection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { normalizePhone } from '../../src/lib/phone.ts';
import { connectLocal, loadEnv, requireEnv } from '../../scripts/family/lib/db.ts';
import { PHONE_CASES } from '../support/phone-cases.ts';

let db: Connection;
let database: string;

before(async () => {
  loadEnv();
  database = requireEnv('DB_TEST_NAME');
  db = await connectLocal(database);
});
after(() => db.end());

describe('household_phone_normalized and normalizePhone', () => {
  test('the column expression gives what normalizePhone gives, on every unit-test input', async () => {
    const [[column]] = await db.query<RowDataPacket[]>(
      `SELECT GENERATION_EXPRESSION AS expr FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'families' AND COLUMN_NAME = 'household_phone_normalized'`,
      [database],
    );
    assert.ok(column?.expr, 'families.household_phone_normalized is a generated column');
    for (const c of PHONE_CASES) {
      const [[row]] = await db.query<RowDataPacket[]>(
        `SELECT ${column.expr} AS normalized FROM (SELECT CAST(? AS CHAR(255)) AS household_phone) families`,
        [c.input],
      );
      assert.equal(row.normalized, normalizePhone(c.input), `SQL vs TypeScript for ${JSON.stringify(c.input)}`);
      assert.equal(row.normalized, c.expected, c.note ?? String(c.input));
    }
  });

  test('the stored column itself, on a written row', async () => {
    await db.beginTransaction();
    try {
      for (const c of PHONE_CASES.filter((x) => x.input !== null)) {
        const [r] = await db.query<ResultSetHeader>(
          `INSERT INTO families (name, household_phone, created_at, updated_at, created_by, updated_by)
           VALUES ('Phone normalization', ?, NOW(), NOW(), 0, 0)`,
          [c.input],
        );
        const [[row]] = await db.query<RowDataPacket[]>('SELECT household_phone_normalized AS n FROM families WHERE id = ?', [r.insertId]);
        assert.equal(row.n, normalizePhone(c.input), `stored value for ${JSON.stringify(c.input)}`);
      }
    } finally {
      await db.rollback();
    }
  });
});
