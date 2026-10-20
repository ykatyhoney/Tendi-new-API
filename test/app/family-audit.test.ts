// The audit helper (src/modules/family/service/audit.ts): one row per changed column, the value
// format, and nothing written for an unchanged value. No database: writeAudit runs on a fake
// connection that records the query. The routes' rows are tested in test/family-db/api-audit.test.ts.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { Queryable } from '../../src/modules/family/db.ts';
import { auditValue, columnChanges, writeAudit } from '../../src/modules/family/service/audit.ts';

const target = { table: 'families', tableId: 7, entityName: 'Family Katz' };

describe('columnChanges', () => {
  test('update: a row for each changed column only', () => {
    const before = { name: 'Katz', household_phone: '718-555-0100', status: 'active' };
    assert.deepEqual(columnChanges(target, 'update', before, { name: 'Katz-Levi', household_phone: '718-555-0100' }), [
      { ...target, action: 'update', column: 'name', oldValue: 'Katz', newValue: 'Katz-Levi' },
    ]);
    assert.deepEqual(columnChanges(target, 'update', before, { name: 'Katz' }), []);
  });

  test('values compare as text: tinyint 1 equals true, numbers equal their string, dates as stored', () => {
    const before = { is_primary: 1, sort_order: 2, collect_from: '2026-09-01', note: null };
    const after = { is_primary: true, sort_order: 2, collect_from: '2026-09-01', note: null };
    assert.deepEqual(columnChanges(target, 'update', before, after), []);
    assert.deepEqual(
      columnChanges(target, 'update', before, { is_primary: false, note: '' }).map((c) => [
        c.column,
        c.oldValue,
        c.newValue,
      ]),
      [
        ['is_primary', '1', '0'],
        ['note', null, ''],
      ],
    );
  });

  test('insert has no before and delete no after; a NULL there is no change', () => {
    assert.deepEqual(
      columnChanges(target, 'insert', null, { name: 'Katz', collect_from: null, is_emergency: false }).map((c) => [
        c.action,
        c.column,
        c.oldValue,
        c.newValue,
      ]),
      [
        ['insert', 'name', null, 'Katz'],
        ['insert', 'is_emergency', null, '0'],
      ],
    );
    assert.deepEqual(
      columnChanges(target, 'delete', { member_id: 3, collect_to: null }, null).map((c) => [
        c.column,
        c.oldValue,
        c.newValue,
      ]),
      [['member_id', '3', null]],
    );
  });

  test('columns limits what is compared', () => {
    const rows = columnChanges(target, 'update', { a: 1, b: 1 }, { a: 2, b: 2 }, ['b']);
    assert.deepEqual(
      rows.map((c) => c.column),
      ['b'],
    );
  });

  test('auditValue', () => {
    assert.deepEqual([true, false, 0, 12, '', 'x', null, undefined].map(auditValue), [
      '1',
      '0',
      '0',
      '12',
      '',
      'x',
      null,
      null,
    ]);
  });
});

describe('writeAudit', () => {
  function fakeConnection() {
    const calls: { sql: string; params: unknown[] }[] = [];
    const conn = { query: async (sql: string, params: unknown[]) => (calls.push({ sql, params }), [{}]) };
    return { conn: conn as unknown as Queryable, calls };
  }

  test("writes on the given connection with type 'family_api', the staff member and actor_type 'admin'", async () => {
    const { conn, calls } = fakeConnection();
    await writeAudit(conn, { adminId: 42, type: 'office', name: 'Office' }, [
      { ...target, action: 'update', column: 'name', oldValue: 'Katz', newValue: 'Levi' },
    ]);
    assert.equal(calls.length, 1);
    assert.match(calls[0].sql, /INSERT INTO audit_logs/);
    assert.deepEqual(calls[0].params, [
      [['family_api', 'families', 'update', 'name', 'Katz', 'Levi', 42, 'admin', 'family-api', 7, 'Family Katz']],
    ]);
  });

  test('drops unchanged values, and writes nothing when none changed', async () => {
    const { conn, calls } = fakeConnection();
    await writeAudit(conn, { adminId: 42, type: 'office', name: 'Office' }, [
      { ...target, action: 'update', column: 'phones', oldValue: '[]', newValue: '[]' },
    ]);
    assert.equal(calls.length, 0);
  });
});
