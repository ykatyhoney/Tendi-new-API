// Dev-only staff tokens (scripts/family/dev-token/token.ts, npm run family:dev-token): which
// databases are allowed, creating a token for an active admin (only its md5 stored), refusing
// unknown or inactive admins, and revoking only that admin's dev tokens. Each test is rolled back.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, test } from 'node:test';
import {
  assertDevDatabase,
  createDevToken,
  DEV_APP_VERSION,
  DEV_DEVICE_ID,
  revokeDevTokens,
} from '../../scripts/family/dev-token/token.ts';
import { rows, useTestDatabase, value } from './support/db.ts';

const db = useTestDatabase();

const adminOf = (type: string, status = 'active') =>
  value<number>(db(), 'SELECT id FROM admin WHERE type = ? AND status = ? ORDER BY id LIMIT 1', [type, status]);

describe('dev tokens', () => {
  test('only tendi_family_dev and tendi_family_test are allowed', () => {
    assert.doesNotThrow(() => assertDevDatabase('tendi_family_dev'));
    assert.doesNotThrow(() => assertDevDatabase('tendi_family_test'));
    for (const name of ['tendi', 'tendi_family_prod', 'tendi_family_test2', 'TENDI_FAMILY_DEV', '']) {
      assert.throws(() => assertDevDatabase(name), /refusing to make or revoke dev tokens/, name);
    }
  });

  test('creates a row for an active admin with the md5 only, found by MD5(token)', async () => {
    const adminId = await adminOf('office');
    const { token, tokenId, admin } = await createDevToken(db(), adminId);
    assert.match(token, /^[0-9a-f]{64}$/);
    assert.equal(admin.id, adminId);
    const [row] = await rows(db(), 'SELECT admin_id, token_hash, device_id, app_version FROM admin_api_tokens WHERE id = ?', [tokenId]);
    assert.deepEqual({ ...row }, {
      admin_id: adminId,
      token_hash: createHash('md5').update(token).digest('hex'),
      device_id: DEV_DEVICE_ID,
      app_version: DEV_APP_VERSION,
    });
    assert.notEqual(row.token_hash, token, 'the raw token is not stored');
    // The API looks the token up by md5 (lowercase hex): MariaDB's MD5() of the raw token finds the row.
    assert.equal(await value(db(), 'SELECT admin_id FROM admin_api_tokens WHERE token_hash = MD5(?)', [token]), adminId);
  });

  test('refuses an unknown or inactive admin', async () => {
    await assert.rejects(createDevToken(db(), 2147483647), /admin 2147483647 does not exist/);
    const trashed = await adminOf('teacher', 'trash');
    await assert.rejects(createDevToken(db(), trashed), new RegExp(`admin ${trashed} is trash, not active`));
  });

  test("revoke deletes that admin's dev tokens only", async () => {
    const adminId = await adminOf('office');
    const other = await adminOf('admin');
    await createDevToken(db(), adminId);
    await createDevToken(db(), adminId);
    await createDevToken(db(), other);
    await db().query(
      "INSERT INTO admin_api_tokens (admin_id, token_hash, device_id, app_version, created_at, last_seen_at) VALUES (?, MD5('phone'), 'some-phone', '1.0', NOW(), NOW())",
      [adminId],
    );
    assert.equal(await revokeDevTokens(db(), adminId), 2);
    assert.equal(await revokeDevTokens(db(), adminId), 0);
    const left = await rows(db(), 'SELECT admin_id, device_id FROM admin_api_tokens WHERE admin_id IN (?, ?) ORDER BY admin_id, device_id', [adminId, other]);
    assert.deepEqual(
      left.map((r) => [r.admin_id, r.device_id]),
      [
        [adminId, 'some-phone'],
        [other, DEV_DEVICE_ID],
      ].sort((a, b) => Number(a[0]) - Number(b[0])),
    );
  });
});
