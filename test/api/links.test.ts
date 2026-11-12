import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { RowDataPacket } from 'mysql2/promise'
import mysql from 'mysql2/promise'
import { afterAll, describe, expect, it } from 'vitest'
import { quoteIdentifier } from '../../src/lib/sql.js'
import { buildApp } from '../../src/app.js'
import { loadConfig } from '../../src/config/env.js'
import { sameLegacyValue } from '../../src/modules/family/services/mirror/derive.js'
import { ADDITIONAL_MIRROR_COLUMNS, CHILDREN_MIRROR_COLUMNS } from '../../src/modules/family/services/mirror/types.js'
import { issueDevToken, revokeDevTokens } from '../../scripts/dev-token.js'
import { loadAdminConfig } from '../../scripts/mariadb-admin.js'
import { asFamilyApi, unlinkWithFlag } from '../helpers/lock.js'

const TEST_DATABASE = 'tendi_family_test'
const MIRROR_COLUMNS = [...CHILDREN_MIRROR_COLUMNS, ...ADDITIONAL_MIRROR_COLUMNS]
const BIT_COLUMNS = new Set(['use_father_phone_for_notification', 'use_mother_phone_for_notification'])

interface BackfillChild {
  childId: number
  familyId: number
  diffs: { column: string; family: string }[]
}

interface ColumnSnapshot {
  id: number
  familyId: number | null
  children: Record<string, string | number | null>
  additional: Record<string, string | number | null> | null
}

const adminConfig = loadAdminConfig()
const connection = await mysql.createConnection({
  host: adminConfig.host,
  port: adminConfig.port,
  user: adminConfig.user,
  password: adminConfig.password,
  database: TEST_DATABASE,
  charset: 'utf8mb4',
  dateStrings: true,
  timezone: 'Z',
})
const [adminRows] = await connection.query<RowDataPacket[]>(
  `SELECT id FROM admin WHERE status = 'active' AND type = 'admin' ORDER BY id LIMIT 1`,
)
const adminId = Number(adminRows[0]?.['id'])
if (!Number.isInteger(adminId) || adminId < 1) {
  throw new Error('tendi_family_test has no active admin.')
}
const token = await issueDevToken(connection, adminId)
const config = await loadConfig()
const app = await buildApp({
  config: { ...config, db: { ...config.db, name: TEST_DATABASE } },
  logger: false,
})
const createdFamilies: number[] = []

describe('link, unlink, preview and rights', () => {
  const auth = { authorization: `Bearer ${token}` }

  afterAll(async () => {
    await deleteCreated()
    await revokeDevTokens(connection, adminId)
    await connection.end()
    await app.close()
  })

  it('previews a linked child as unchanged and refuses a bad link', async () => {
    const [linked] = await connection.query<RowDataPacket[]>(
      `SELECT id, family_id AS familyId FROM children WHERE family_id IS NOT NULL AND status <> 'trash' ORDER BY id LIMIT 1`,
    )
    const childId = Number(linked[0]?.['id'])
    const familyId = Number(linked[0]?.['familyId'])
    const preview = await app.inject({
      method: 'GET',
      url: `/api/v1/families/${familyId}/children/${childId}/preview`,
      headers: auth,
    })
    expect(preview.statusCode).toBe(200)
    const body = preview.json()
    expect(body.currentFamilyId).toBe(familyId)
    expect(body.columns).toHaveLength(28)
    expect(body.columns.every((column: { changed: boolean }) => column.changed === false)).toBe(true)

    const [other] = await connection.query<RowDataPacket[]>(
      `SELECT f.id
       FROM families AS f
       INNER JOIN family_members AS m ON m.family_id = f.id AND m.status = 'active'
       WHERE f.status = 'active' AND f.id <> ?
       ORDER BY f.id
       LIMIT 1`,
      [familyId],
    )
    const otherFamilyId = Number(other[0]?.['id'])
    const refused = await app.inject({
      method: 'POST',
      url: `/api/v1/families/${otherFamilyId}/children/${childId}/link`,
      headers: auth,
    })
    expect(refused.statusCode).toBe(409)
    expect(refused.json().code).toBe('ALREADY_LINKED')
    const [still] = await connection.query<RowDataPacket[]>(`SELECT family_id AS familyId FROM children WHERE id = ?`, [childId])
    expect(Number(still[0]?.['familyId'])).toBe(familyId)

    const empty = await app.inject({
      method: 'POST',
      url: '/api/v1/families',
      headers: auth,
      payload: { name: 'B7 Empty' },
    })
    expect(empty.statusCode).toBe(200)
    const emptyId = empty.json().family.id
    createdFamilies.push(emptyId)
    const [unlinked] = await connection.query<RowDataPacket[]>(
      `SELECT id FROM children WHERE family_id IS NULL AND status <> 'trash' ORDER BY id LIMIT 1`,
    )
    const unlinkedId = Number(unlinked[0]?.['id'])
    const noMembers = await app.inject({
      method: 'POST',
      url: `/api/v1/families/${emptyId}/children/${unlinkedId}/link`,
      headers: auth,
    })
    expect(noMembers.statusCode).toBe(409)
    expect(noMembers.json().code).toBe('NO_MEMBERS')
    const [untouched] = await connection.query<RowDataPacket[]>(
      `SELECT family_id AS familyId FROM children WHERE id = ?`,
      [unlinkedId],
    )
    expect(untouched[0]?.['familyId']).toBeNull()

    const missing = await app.inject({
      method: 'GET',
      url: '/api/v1/families/999999999/children/999999999/preview',
      headers: auth,
    })
    expect(missing.statusCode).toBe(404)
  })

  it('links an unlinked child to the backfill values, then keeps them after unlink', async () => {
    const sample = await backfillChild()
    const before = await snapshotChild(sample.childId)
    expect(before.familyId).toBeNull()
    const beforePhone = await rawColumn(sample.childId, 'father_phone')
    try {
      const preview = await app.inject({
        method: 'GET',
        url: `/api/v1/families/${sample.familyId}/children/${sample.childId}/preview`,
        headers: auth,
      })
      expect(preview.statusCode).toBe(200)
      expect(await rawColumn(sample.childId, 'father_phone')).toBe(beforePhone)
      const columns = preview.json().columns as {
        column: string
        after: string | number | null
        changed: boolean
        tooLong: boolean
      }[]
      expect(columns.filter((column) => column.changed).map((column) => column.column).sort()).toEqual(
        sample.diffs.map((diff) => diff.column).sort(),
      )
      expect(columns.some((column) => column.tooLong)).toBe(false)
      for (const diff of sample.diffs) {
        const column = columns.find((item) => item.column === diff.column)
        expect(column?.after).toBe(diff.family)
      }

      const linked = await app.inject({
        method: 'POST',
        url: `/api/v1/families/${sample.familyId}/children/${sample.childId}/link`,
        headers: auth,
      })
      expect(linked.statusCode).toBe(200)
      expect(linked.json().affected_child_ids).toContain(sample.childId)
      for (const column of columns) {
        const stored = await rawColumn(sample.childId, column.column)
        expect(sameLegacyValue(stored, column.after)).toBe(true)
      }
      const [audit] = await connection.query<RowDataPacket[]>(
        `SELECT col_name, old_value, new_value, actor_ref FROM audit_logs
         WHERE table_name = 'children' AND table_id = ? AND col_name = 'family_id'
         ORDER BY id DESC LIMIT 1`,
        [sample.childId],
      )
      expect(audit[0]?.['new_value']).toBe(String(sample.familyId))
      expect(audit[0]?.['actor_ref']).toBe('tendi-new')

      const unlinked = await app.inject({
        method: 'POST',
        url: `/api/v1/children/${sample.childId}/unlink`,
        headers: auth,
      })
      expect(unlinked.statusCode).toBe(200)
      expect(unlinked.json()).toMatchObject({ familyId: null, affected_child_ids: [] })
      const [family] = await connection.query<RowDataPacket[]>(
        `SELECT family_id AS familyId FROM children WHERE id = ?`,
        [sample.childId],
      )
      expect(family[0]?.['familyId']).toBeNull()
      for (const column of columns) {
        const stored = await rawColumn(sample.childId, column.column)
        expect(sameLegacyValue(stored, column.after)).toBe(true)
      }
    } finally {
      await restoreChild(before)
    }
  })

  it('refuses rights for a child linked to another family', async () => {
    const [rows] = await connection.query<RowDataPacket[]>(
      `SELECT c.id AS childId, c.family_id AS linkedFamilyId,
              (SELECT f.id FROM families AS f WHERE f.status = 'active' AND f.id <> c.family_id ORDER BY f.id LIMIT 1) AS otherFamilyId
       FROM children AS c
       WHERE c.family_id IS NOT NULL AND c.status <> 'trash'
       ORDER BY c.id
       LIMIT 1`,
    )
    const childId = Number(rows[0]?.['childId'])
    const otherFamilyId = Number(rows[0]?.['otherFamilyId'])
    const refused = await app.inject({
      method: 'PUT',
      url: `/api/v1/families/${otherFamilyId}/children/${childId}/rights`,
      headers: auth,
      payload: { rights: [] },
    })
    expect(refused.statusCode).toBe(409)
    expect(refused.json()).toMatchObject({
      code: 'ALREADY_LINKED',
      details: { familyId: Number(rows[0]?.['linkedFamilyId']) },
    })
  })

  it('saves rights for every member and re-mirrors a linked child', async () => {
    const [samples] = await connection.query<RowDataPacket[]>(
      `SELECT c.id AS childId, c.family_id AS familyId
       FROM children AS c
       WHERE c.family_id IS NOT NULL AND c.status <> 'trash'
         AND (
           SELECT COUNT(*)
           FROM family_members AS m
           INNER JOIN family_contacts AS fc ON fc.id = m.family_contact_id AND fc.status = 'active'
           WHERE m.family_id = c.family_id AND m.status = 'active'
         ) = (
           SELECT COUNT(*)
           FROM family_member_children AS r
           INNER JOIN family_members AS m ON m.id = r.member_id AND m.family_id = c.family_id AND m.status = 'active'
           INNER JOIN family_contacts AS fc ON fc.id = m.family_contact_id AND fc.status = 'active'
           WHERE r.child_id = c.id
         )
         AND EXISTS (
           SELECT 1
           FROM family_members AS m
           INNER JOIN relationship_types AS rt ON rt.code = m.relationship AND rt.parent_slot = 'father' AND rt.slot_rank = 1
           INNER JOIN family_member_children AS r ON r.member_id = m.id AND r.child_id = c.id
           WHERE m.family_id = c.family_id AND m.status = 'active' AND r.notify_method = 'voice'
         )
       ORDER BY c.id
       LIMIT 1`,
    )
    const childId = Number(samples[0]?.['childId'])
    const familyId = Number(samples[0]?.['familyId'])
    expect(childId).toBeGreaterThan(0)
    const original = await rightsRows(familyId, childId)
    const father = original.find((row) => row.slot === 'father' && row.slotRank === 1)
    if (father === undefined) {
      throw new Error('The rights sample has no father.')
    }
    const payload = original.map((row) => ({
      memberId: row.memberId,
      receivesNotifications: row.memberId === father.memberId ? true : row.receivesNotifications,
      notifyMethod: row.memberId === father.memberId ? 'sms' : row.notifyMethod,
      mayCollect: row.mayCollect,
      collectFrom: row.collectFrom,
      collectTo: row.collectTo,
      isEmergency: row.isEmergency,
      isPaymentResponsible: row.isPaymentResponsible,
    }))
    try {
      const missing = await app.inject({
        method: 'PUT',
        url: `/api/v1/families/${familyId}/children/${childId}/rights`,
        headers: auth,
        payload: { rights: payload.slice(1) },
      })
      expect(missing.statusCode).toBe(400)
      expect(missing.json().code).toBe('VALIDATION')

      const backwards = await app.inject({
        method: 'PUT',
        url: `/api/v1/families/${familyId}/children/${childId}/rights`,
        headers: auth,
        payload: {
          rights: payload.map((row) =>
            row.memberId === father.memberId
              ? { ...row, collectFrom: '2026-02-02', collectTo: '2026-02-01' }
              : row,
          ),
        },
      })
      expect(backwards.statusCode).toBe(400)

      const saved = await app.inject({
        method: 'PUT',
        url: `/api/v1/families/${familyId}/children/${childId}/rights`,
        headers: auth,
        payload: { rights: payload },
      })
      expect(saved.statusCode).toBe(200)
      expect(saved.json().affected_child_ids).toContain(childId)
      const [mirrored] = await connection.query<RowDataPacket[]>(
        `SELECT use_father_phone_for_notification + 0 AS flag, notification_father_phone_method AS method
         FROM children WHERE id = ?`,
        [childId],
      )
      expect(Number(mirrored[0]?.['flag'])).toBe(1)
      expect(mirrored[0]?.['method']).toBe('sms')
    } finally {
      const restored = await app.inject({
        method: 'PUT',
        url: `/api/v1/families/${familyId}/children/${childId}/rights`,
        headers: auth,
        payload: {
          rights: original.map((row) => ({
            memberId: row.memberId,
            receivesNotifications: row.receivesNotifications,
            notifyMethod: row.notifyMethod,
            mayCollect: row.mayCollect,
            collectFrom: row.collectFrom,
            collectTo: row.collectTo,
            isEmergency: row.isEmergency,
            isPaymentResponsible: row.isPaymentResponsible,
          })),
        },
      })
      expect(restored.statusCode).toBe(200)
    }
  })

  it('lists a linked child that the main admin trashed, and lets it be unlinked so the family can be archived', async () => {
    // A family with exactly one linked child: that child alone is what keeps the family from being archived.
    const [found] = await connection.query<RowDataPacket[]>(
      `SELECT c.id AS childId, c.family_id AS familyId, c.status AS status, f.name AS familyName
       FROM children AS c
       INNER JOIN families AS f ON f.id = c.family_id AND f.status = 'active'
       WHERE c.status <> 'trash'
         AND (SELECT COUNT(*) FROM children AS sibling WHERE sibling.family_id = c.family_id) = 1
         AND EXISTS (
           SELECT 1 FROM family_member_children AS r
           INNER JOIN family_members AS m ON m.id = r.member_id AND m.family_id = c.family_id AND m.status = 'active'
           WHERE r.child_id = c.id
         )
       ORDER BY c.id
       LIMIT 1`,
    )
    expect(found[0], 'an active family with exactly one linked child, who has rights there').toBeDefined()
    const childId = Number(found[0]?.['childId'])
    const familyId = Number(found[0]?.['familyId'])
    const familyName = String(found[0]?.['familyName'])
    const before = await snapshotChild(childId)
    const [auditMark] = await connection.query<RowDataPacket[]>(`SELECT COALESCE(MAX(id), 0) AS id FROM audit_logs`)
    const family = () => app.inject({ method: 'GET', url: `/api/v1/families/${familyId}`, headers: auth })
    const archive = () =>
      app.inject({ method: 'PATCH', url: `/api/v1/families/${familyId}`, headers: auth, payload: { status: 'trash' } })
    try {
      expect((await family()).json().children).toEqual([expect.objectContaining({ id: childId, status: found[0]?.['status'] })])

      // The legacy app trashes the child. It stays linked: only this API may clear family_id.
      await connection.query(`UPDATE children SET status = 'trash' WHERE id = ?`, [childId])

      // The family's own page still lists it, marked as trashed, without its rights (they cannot be saved).
      const detail = (await family()).json()
      expect(detail.children).toEqual([expect.objectContaining({ id: childId, status: 'trash' })])
      const rights = detail.members.flatMap((member: { rights: { childId: number }[] }) => member.rights)
      expect(rights.some((row: { childId: number }) => row.childId === childId)).toBe(false)

      // The family list leaves a trashed child out.
      let summary: { id: number; childCount: number; children: { id: number }[] } | undefined
      for (let page = 1; page <= 10 && summary === undefined; page += 1) {
        const listed = (
          await app.inject({
            method: 'GET',
            url: `/api/v1/families?q=${encodeURIComponent(familyName)}&page=${page}&pageSize=100`,
            headers: auth,
          })
        ).json()
        summary = listed.items.find((item: { id: number }) => item.id === familyId)
        if (page * 100 >= listed.total) {
          break
        }
      }
      expect(summary).toMatchObject({ id: familyId, childCount: 0, children: [] })

      // It still blocks archiving, and the answer names it.
      const refused = await archive()
      expect(refused.statusCode).toBe(409)
      expect(refused.json()).toMatchObject({ code: 'HAS_LINKED_CHILDREN', details: { childIds: [childId] } })

      // Unlink works for it, and leaves the 28 old values as they are.
      const unlinked = await app.inject({ method: 'POST', url: `/api/v1/children/${childId}/unlink`, headers: auth })
      expect(unlinked.statusCode, unlinked.body).toBe(200)
      expect(unlinked.json()).toEqual({ childId, familyId: null, affected_child_ids: [] })
      const after = await snapshotChild(childId)
      expect(after.familyId).toBeNull()
      expect(after.children).toEqual(before.children)
      expect(after.additional).toEqual(before.additional)
      expect((await family()).json().children).toEqual([])

      // A second unlink has nothing to do.
      const again = await app.inject({ method: 'POST', url: `/api/v1/children/${childId}/unlink`, headers: auth })
      expect(again.statusCode).toBe(404)

      const archived = await archive()
      expect(archived.statusCode, archived.body).toBe(200)
      expect(archived.json().family.status).toBe('trash')
    } finally {
      // Back to the dump's state: the family active, the child linked to it (as family_api, under the mirror
      // flag, which changes none of the 28 columns), its status, and none of this test's audit rows.
      await connection.query(`UPDATE families SET status = 'active' WHERE id = ?`, [familyId])
      await asFamilyApi(app.db, (session) =>
        session.query(`UPDATE children SET family_id = ? WHERE id = ?`, [familyId, childId]),
      )
      await connection.query(`UPDATE children SET status = ? WHERE id = ?`, [found[0]?.['status'], childId])
      await connection.query(`DELETE FROM audit_logs WHERE id > ?`, [auditMark[0]?.['id']])
    }
    const restored = await snapshotChild(childId)
    expect(restored).toEqual(before)
  })

  it('puts a root edit of a linked parent name back and logs it', async () => {
    const [children] = await connection.query<RowDataPacket[]>(
      `SELECT id, father_name AS fatherName FROM children WHERE family_id IS NOT NULL ORDER BY id LIMIT 1`,
    )
    const childId = Number(children[0]?.['id'])
    const fatherName = String(children[0]?.['fatherName'])
    const [before] = await connection.query<RowDataPacket[]>(
      `SELECT COALESCE(MAX(id), 0) AS id FROM family_mirror_lock_log WHERE child_id = ?`,
      [childId],
    )
    const logId = Number(before[0]?.['id'])
    try {
      await connection.query(`UPDATE children SET father_name = ? WHERE id = ?`, ['LOCK-TEST', childId])
      const [after] = await connection.query<RowDataPacket[]>(
        `SELECT father_name AS fatherName FROM children WHERE id = ?`,
        [childId],
      )
      expect(after[0]?.['fatherName']).toBe(fatherName)
      const [logs] = await connection.query<RowDataPacket[]>(
        `SELECT attempted_value AS attempted, kept_value AS kept, col_name AS columnName
         FROM family_mirror_lock_log WHERE child_id = ? AND id > ?`,
        [childId, logId],
      )
      expect(logs).toEqual([
        expect.objectContaining({ attempted: 'LOCK-TEST', kept: fatherName, columnName: 'father_name' }),
      ])
    } finally {
      await connection.query(`UPDATE children SET father_name = ? WHERE id = ?`, [fatherName, childId])
      await connection.query(`DELETE FROM family_mirror_lock_log WHERE child_id = ? AND id > ?`, [childId, logId])
    }
  })
})

async function backfillChild(): Promise<BackfillChild> {
  const text = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../db/family_backfill_report.csv'), 'utf8')
  const rows = parseCsv(text).slice(1)
  const candidates = rows
    .map((row) => ({
      childId: Number(row[0]),
      familyId: Number(row[2]),
      linked: row[4],
      differences: Number(row[5]),
      diffs: parseDiffs(row[6] ?? ''),
    }))
    .filter((row) => row.linked === 'no' && row.familyId > 0 && row.differences > 0 && row.diffs !== null)
    .sort((left, right) => left.childId - right.childId)
  for (const candidate of candidates) {
    const [families] = await connection.query<RowDataPacket[]>(
      `SELECT f.id
       FROM families AS f
       INNER JOIN family_members AS m ON m.family_id = f.id AND m.status = 'active'
       INNER JOIN children AS c ON c.id = ? AND c.family_id IS NULL AND c.status <> 'trash'
       WHERE f.id = ? AND f.status = 'active'
       LIMIT 1`,
      [candidate.childId, candidate.familyId],
    )
    if (families.length > 0 && candidate.diffs !== null && candidate.diffs.length === candidate.differences) {
      return { childId: candidate.childId, familyId: candidate.familyId, diffs: candidate.diffs }
    }
  }
  throw new Error('No unlinked backfill child is available to link.')
}

function parseDiffs(text: string): { column: string; family: string }[] | null {
  if (text.trim() === '') {
    return []
  }
  const parts = text.split(' | ')
  const diffs = []
  for (const part of parts) {
    const match = part.match(/^([A-Za-z0-9_]+): today '(.*)' -> family '(.*)'$/)
    if (match?.[1] === undefined || match[3] === undefined) {
      return null
    }
    diffs.push({ column: match[1], family: match[3] })
  }
  return diffs
}

async function rightsRows(familyId: number, childId: number) {
  const [rows] = await connection.query<RowDataPacket[]>(
    `SELECT m.id AS memberId, rt.parent_slot AS slot, rt.slot_rank AS slotRank,
            r.receives_notifications AS receivesNotifications, r.notify_method AS notifyMethod,
            r.may_collect AS mayCollect, r.collect_from AS collectFrom, r.collect_to AS collectTo,
            r.is_emergency AS isEmergency, r.is_payment_responsible AS isPaymentResponsible
     FROM family_members AS m
     INNER JOIN family_contacts AS c ON c.id = m.family_contact_id AND c.status = 'active'
     INNER JOIN relationship_types AS rt ON rt.code = m.relationship
     INNER JOIN family_member_children AS r ON r.member_id = m.id AND r.child_id = ?
     WHERE m.family_id = ? AND m.status = 'active'
     ORDER BY m.id`,
    [childId, familyId],
  )
  return rows.map((row) => ({
    memberId: Number(row['memberId']),
    slot: row['slot'] === null ? null : String(row['slot']),
    slotRank: row['slotRank'] === null ? null : Number(row['slotRank']),
    receivesNotifications: Number(row['receivesNotifications']) === 1,
    notifyMethod: String(row['notifyMethod']) as 'sms' | 'voice' | 'both',
    mayCollect: Number(row['mayCollect']) === 1,
    collectFrom: row['collectFrom'] === null ? null : String(row['collectFrom']).slice(0, 10),
    collectTo: row['collectTo'] === null ? null : String(row['collectTo']).slice(0, 10),
    isEmergency: Number(row['isEmergency']) === 1,
    isPaymentResponsible: Number(row['isPaymentResponsible']) === 1,
  }))
}

async function rawColumn(childId: number, column: string): Promise<string | number | null> {
  if (!MIRROR_COLUMNS.includes(column as (typeof MIRROR_COLUMNS)[number])) {
    throw new Error(`Unexpected mirror column ${column}.`)
  }
  const table = (CHILDREN_MIRROR_COLUMNS as readonly string[]).includes(column) ? 'children' : 'children_additional_information'
  const idColumn = table === 'children' ? 'id' : 'child_id'
  const selected = BIT_COLUMNS.has(column) ? `${quoteIdentifier(column)} + 0 AS value` : `${quoteIdentifier(column)} AS value`
  const [rows] = await connection.query<RowDataPacket[]>(
    `SELECT ${selected} FROM ${quoteIdentifier(table)} WHERE ${quoteIdentifier(idColumn)} = ?`,
    [childId],
  )
  const value = rows[0]?.['value']
  if (value === null || value === undefined) {
    return null
  }
  if (typeof value === 'number') {
    return value
  }
  return String(value)
}

async function snapshotChild(childId: number): Promise<ColumnSnapshot> {
  const [children] = await connection.query<RowDataPacket[]>(
    `SELECT family_id AS familyId, ${selectList(CHILDREN_MIRROR_COLUMNS)} FROM children WHERE id = ?`,
    [childId],
  )
  const [additional] = await connection.query<RowDataPacket[]>(
    `SELECT ${selectList(ADDITIONAL_MIRROR_COLUMNS)} FROM children_additional_information WHERE child_id = ?`,
    [childId],
  )
  const child = children[0]
  if (child === undefined) {
    throw new Error(`Child ${childId} is missing.`)
  }
  return {
    id: childId,
    familyId: child['familyId'] === null ? null : Number(child['familyId']),
    children: recordOf(CHILDREN_MIRROR_COLUMNS, child),
    additional: additional[0] === undefined ? null : recordOf(ADDITIONAL_MIRROR_COLUMNS, additional[0]),
  }
}

async function restoreChild(child: ColumnSnapshot): Promise<void> {
  // The backfill child starts unlinked. Root may only clear family_id with @family_unlink = 1 (revision 4).
  await unlinkWithFlag(connection, child.id)
  await connection.query(
    `UPDATE children SET ${assignments(CHILDREN_MIRROR_COLUMNS)} WHERE id = ?`,
    [...values(CHILDREN_MIRROR_COLUMNS, child.children), child.id],
  )
  if (child.additional !== null) {
    await connection.query(
      `UPDATE children_additional_information SET ${assignments(ADDITIONAL_MIRROR_COLUMNS)} WHERE child_id = ?`,
      [...values(ADDITIONAL_MIRROR_COLUMNS, child.additional), child.id],
    )
  }
}

async function deleteCreated(): Promise<void> {
  if (createdFamilies.length === 0) {
    return
  }
  await connection.query(
    `DELETE FROM families WHERE id IN (${createdFamilies.map(() => '?').join(', ')})`,
    createdFamilies,
  )
}

function selectList(columns: readonly string[]): string {
  return columns
    .map((column) =>
      BIT_COLUMNS.has(column) ? `${quoteIdentifier(column)} + 0 AS ${quoteIdentifier(column)}` : quoteIdentifier(column),
    )
    .join(', ')
}

function assignments(columns: readonly string[]): string {
  return columns.map((column) => `${quoteIdentifier(column)} = ?`).join(', ')
}

function values(columns: readonly string[], row: Record<string, string | number | null>): unknown[] {
  return columns.map((column) => row[column] ?? null)
}

function recordOf(columns: readonly string[], row: RowDataPacket): Record<string, string | number | null> {
  const record: Record<string, string | number | null> = {}
  for (const column of columns) {
    const value = row[column]
    if (value === null || value === undefined) {
      record[column] = null
    } else if (typeof value === 'number') {
      record[column] = value
    } else {
      record[column] = String(value)
    }
  }
  return record
}

function parseCsv(text: string): string[][] {
  const table: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          cell += '"'
          index += 1
        } else {
          quoted = false
        }
      } else {
        cell += char ?? ''
      }
    } else if (char === '"') {
      quoted = true
    } else if (char === ',') {
      row.push(cell)
      cell = ''
    } else if (char === '\n') {
      row.push(cell)
      table.push(row)
      row = []
      cell = ''
    } else if (char !== '\r') {
      cell += char ?? ''
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell)
    table.push(row)
  }
  return table
}
