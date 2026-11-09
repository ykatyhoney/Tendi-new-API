import type { Connection, RowDataPacket } from 'mysql2/promise'
import mysql from 'mysql2/promise'
import { afterAll, describe, expect, it } from 'vitest'
import { buildApp } from '../../src/app.js'
import { loadConfig } from '../../src/config/env.js'
import { quoteIdentifier } from '../../src/lib/sql.js'
import { reconcileDatabase } from '../../src/modules/family/services/mirror/reconcile.js'
import { ADDITIONAL_MIRROR_COLUMNS, CHILDREN_MIRROR_COLUMNS } from '../../src/modules/family/services/mirror/types.js'
import { RELATIONSHIP_TYPES_CACHE_KEY } from '../../src/modules/family/services/relationship-types.js'
import { issueDevToken, revokeDevTokens } from '../../scripts/dev-token.js'
import { loadAdminConfig } from '../../scripts/mariadb-admin.js'

/*
 * LOGIC-ISSUES.md fixes (F1-F19), against tendi_family_test. Each test reproduces one issue.
 * Every family, contact, type and rights row this file creates is deleted after, and every child it links is
 * unlinked and given back its 28 stored values.
 */

const TEST_DATABASE = 'tendi_family_test'
const TYPES = { uncle: 'lf_uncle', cousin: 'lf_cousin', nanny: 'lf_nanny', locked: 'lf_lockcheck' }
const BAD_CODES = ['___', '_ab']

const adminConfig = loadAdminConfig()
async function adminConnection(): Promise<Connection> {
  return mysql.createConnection({
    host: adminConfig.host,
    port: adminConfig.port,
    user: adminConfig.user,
    password: adminConfig.password,
    database: TEST_DATABASE,
    charset: 'utf8mb4',
    dateStrings: true,
    timezone: 'Z',
  })
}
const connection = await adminConnection()
const [adminRows] = await connection.query<RowDataPacket[]>(
  `SELECT id FROM admin WHERE status = 'active' AND type = 'admin' ORDER BY id LIMIT 1`,
)
const adminId = Number(adminRows[0]?.['id'])
if (!Number.isInteger(adminId) || adminId < 1) {
  throw new Error('tendi_family_test has no active admin.')
}
const token = await issueDevToken(connection, adminId)
// Audit rows written by this file (ours and the legacy ra_* triggers') are removed above these marks.
const [marks] = await connection.query<RowDataPacket[]>(
  `SELECT (SELECT COALESCE(MAX(id), 0) FROM audit_logs) AS audit, (SELECT COALESCE(MAX(id), 0) FROM record_audit) AS record`,
)
const auditMark = Number(marks[0]?.['audit'])
const recordMark = Number(marks[0]?.['record'])
const config = await loadConfig()
const app = await buildApp({ config: { ...config, db: { ...config.db, name: TEST_DATABASE } }, logger: false })
const auth = { authorization: `Bearer ${token}` }

const createdFamilies: number[] = []
const createdContacts: number[] = []
const snapshots = new Map<number, ChildSnapshot>()

interface ChildSnapshot {
  children: Record<string, unknown>
  additional: Record<string, unknown> | null
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function createType(code: string): Promise<void> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/relationship-types',
    headers: auth,
    payload: { code, label: `LF ${code}`, sortOrder: 900 },
  })
  expect(response.statusCode, response.body).toBe(200)
}

async function newFamily(name: string, householdPhone?: string): Promise<number> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/families',
    headers: auth,
    payload: householdPhone === undefined ? { name } : { name, householdPhone },
  })
  expect(response.statusCode, response.body).toBe(200)
  const id = Number(response.json().family.id)
  createdFamilies.push(id)
  return id
}

interface Added {
  memberId: number
  contactId: number
}

async function addMember(
  familyId: number,
  relationship: string,
  fname: string,
  extra: Record<string, unknown> = {},
): Promise<Added> {
  const response = await app.inject({
    method: 'POST',
    url: `/api/v1/families/${familyId}/members`,
    headers: auth,
    payload: { relationship, contact: { fname, lname: 'Logicfix' }, ...extra },
  })
  expect(response.statusCode, response.body).toBe(200)
  const member = (response.json().family.members as { id: number; contact: { id: number; fname: string } }[]).find(
    (row) => row.contact.fname === fname,
  )
  if (member === undefined) {
    throw new Error(`member ${fname} not in the response`)
  }
  createdContacts.push(member.contact.id)
  return { memberId: member.id, contactId: member.contact.id }
}

async function setEmail(contactId: number, email: string): Promise<void> {
  const response = await app.inject({
    method: 'PUT',
    url: `/api/v1/contacts/${contactId}/emails`,
    headers: auth,
    payload: { emails: [{ email, isPrimary: true }] },
  })
  expect(response.statusCode, response.body).toBe(200)
}

/** An unlinked child, with its 28 values saved so afterAll can give them back. */
async function unlinkedChild(): Promise<number> {
  const [found] = await connection.query<RowDataPacket[]>(
    `SELECT id FROM children WHERE family_id IS NULL AND status <> 'trash' ORDER BY id DESC LIMIT 50`,
  )
  const id = found.map((row) => Number(row['id'])).find((candidate) => !snapshots.has(candidate))
  if (id === undefined) {
    throw new Error('no unlinked child left')
  }
  const [childRows] = await connection.query<RowDataPacket[]>(
    `SELECT ${CHILDREN_MIRROR_COLUMNS.map((column) => quoteIdentifier(column)).join(', ')} FROM children WHERE id = ?`,
    [id],
  )
  const [additionalRows] = await connection.query<RowDataPacket[]>(
    `SELECT ${ADDITIONAL_MIRROR_COLUMNS.map((column) => quoteIdentifier(column)).join(', ')}
     FROM children_additional_information WHERE child_id = ?`,
    [id],
  )
  snapshots.set(id, { children: { ...childRows[0] }, additional: additionalRows[0] === undefined ? null : { ...additionalRows[0] } })
  return id
}

async function link(familyId: number, childId: number, payload?: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/families/${familyId}/children/${childId}/link`,
    headers: auth,
    ...(payload === undefined ? {} : { payload }),
  })
}

async function linkOk(familyId: number, childId: number): Promise<void> {
  const response = await link(familyId, childId, { allowEmptyParents: true })
  expect(response.statusCode, response.body).toBe(200)
}

async function childColumn(childId: number, column: string): Promise<unknown> {
  const [found] = await connection.query<RowDataPacket[]>(
    `SELECT ${quoteIdentifier(column)} AS value, family_id AS familyId FROM children WHERE id = ?`,
    [childId],
  )
  return found[0]?.['value']
}

async function familyIdOf(childId: number): Promise<number | null> {
  const [found] = await connection.query<RowDataPacket[]>(`SELECT family_id AS familyId FROM children WHERE id = ?`, [childId])
  const value = found[0]?.['familyId']
  return value === null || value === undefined ? null : Number(value)
}

async function memberRow(memberId: number): Promise<RowDataPacket | undefined> {
  const [found] = await connection.query<RowDataPacket[]>(
    `SELECT status, is_primary + 0 AS isPrimary, relationship FROM family_members WHERE id = ?`,
    [memberId],
  )
  return found[0]
}

/**
 * True once an API query has been running for 300 ms, which in this file means it waits on a lock that a test
 * connection holds. The process list is used because INNODB_TRX does not always list the waiting transaction.
 */
async function waitForLockWait(timeoutMs = 8000): Promise<boolean> {
  const started = Date.now()
  for (;;) {
    const [found] = await connection.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS waiting FROM information_schema.PROCESSLIST
       WHERE USER = 'family_api' AND COMMAND = 'Query' AND TIME_MS >= 300`,
    )
    if (Number(found[0]?.['waiting']) > 0) {
      return true
    }
    if (Date.now() - started > timeoutMs) {
      return false
    }
    await sleep(50)
  }
}

describe('logic fixes against MariaDB', () => {
  afterAll(async () => {
    await cleanUp()
    await app.cache.del(RELATIONSHIP_TYPES_CACHE_KEY)
    await revokeDevTokens(connection, adminId)
    await connection.end()
    await app.close()
  })

  it('F0 setup: creates the test relationship types', async () => {
    for (const code of Object.values(TYPES)) {
      await createType(code)
    }
  })

  it('F1 refuses removing the last active member of a family with linked children (409 HAS_LINKED_CHILDREN)', async () => {
    const familyId = await newFamily('LF F1')
    const father = await addMember(familyId, 'father', 'Fone')
    const childId = await unlinkedChild()
    await linkOk(familyId, childId)
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/v1/families/${familyId}/members/${father.memberId}`,
      headers: auth,
    })
    expect(response.statusCode, response.body).toBe(409)
    expect(response.json().code).toBe('HAS_LINKED_CHILDREN')
    expect(response.json().details).toEqual({ childIds: [childId] })
    expect((await memberRow(father.memberId))?.['status']).toBe('active')
    expect(await childColumn(childId, 'father_name')).toBe('Fone Logicfix')
  })

  it('F2 refuses a link that leaves both parent slots empty, unless allowEmptyParents (409 NO_PARENT_SLOT)', async () => {
    const familyId = await newFamily('LF F2 link')
    await addMember(familyId, TYPES.uncle, 'Uone')
    const childId = await unlinkedChild()
    const refused = await link(familyId, childId)
    expect(refused.statusCode, refused.body).toBe(409)
    expect(refused.json().code).toBe('NO_PARENT_SLOT')
    expect(await familyIdOf(childId)).toBeNull()
    const allowed = await link(familyId, childId, { allowEmptyParents: true })
    expect(allowed.statusCode, allowed.body).toBe(200)
    expect(await familyIdOf(childId)).toBe(familyId)
  })

  it('F2 refuses a member removal that empties both parent slots of linked children, unless allowEmptyParents', async () => {
    const familyId = await newFamily('LF F2 delete')
    const father = await addMember(familyId, 'father', 'Ftwo')
    await addMember(familyId, TYPES.uncle, 'Utwo')
    const childId = await unlinkedChild()
    await linkOk(familyId, childId)
    const refused = await app.inject({
      method: 'DELETE',
      url: `/api/v1/families/${familyId}/members/${father.memberId}`,
      headers: auth,
    })
    expect(refused.statusCode, refused.body).toBe(409)
    expect(refused.json().code).toBe('NO_PARENT_SLOT')
    expect(refused.json().details).toEqual({ childIds: [childId] })
    expect((await memberRow(father.memberId))?.['status']).toBe('active')
    const allowed = await app.inject({
      method: 'DELETE',
      url: `/api/v1/families/${familyId}/members/${father.memberId}`,
      headers: auth,
      payload: { allowEmptyParents: true },
    })
    expect(allowed.statusCode, allowed.body).toBe(200)
    expect(await childColumn(childId, 'father_name')).toBe('')
  })

  it('F2 refuses a relationship change that empties both parent slots of linked children, unless allowEmptyParents', async () => {
    const familyId = await newFamily('LF F2 patch')
    const mother = await addMember(familyId, 'mother', 'Mtwo')
    const childId = await unlinkedChild()
    await linkOk(familyId, childId)
    const url = `/api/v1/families/${familyId}/members/${mother.memberId}`
    const refused = await app.inject({ method: 'PATCH', url, headers: auth, payload: { relationship: TYPES.uncle } })
    expect(refused.statusCode, refused.body).toBe(409)
    expect(refused.json().code).toBe('NO_PARENT_SLOT')
    expect((await memberRow(mother.memberId))?.['relationship']).toBe('mother')
    const allowed = await app.inject({
      method: 'PATCH',
      url,
      headers: auth,
      payload: { relationship: TYPES.uncle, allowEmptyParents: true },
    })
    expect(allowed.statusCode, allowed.body).toBe(200)
    expect(await childColumn(childId, 'mother_name')).toBe('')
  })

  it('F3 refuses fname + " " + lname over 100 characters with 400 on /fname and /lname', async () => {
    const familyId = await newFamily('LF F3 names')
    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/families/${familyId}/members`,
      headers: auth,
      payload: { relationship: TYPES.uncle, contact: { fname: 'ש'.repeat(60), lname: 'ל'.repeat(60) } },
    })
    expect(created.statusCode, created.body).toBe(400)
    expect(created.json().code).toBe('VALIDATION')
    expect(created.json().details.map((detail: { path: string }) => detail.path).sort()).toEqual(['/fname', '/lname'])

    const member = await addMember(familyId, TYPES.uncle, 'Nthree')
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/v1/contacts/${member.contactId}`,
      headers: auth,
      payload: { fname: 'a'.repeat(60), lname: 'b'.repeat(60) },
    })
    expect(patched.statusCode, patched.body).toBe(400)
    expect(patched.json().details.map((detail: { path: string }) => detail.path).sort()).toEqual(['/fname', '/lname'])
    const fits = await app.inject({
      method: 'PATCH',
      url: `/api/v1/contacts/${member.contactId}`,
      headers: auth,
      payload: { fname: 'a'.repeat(50), lname: 'b'.repeat(49) },
    })
    expect(fits.statusCode, fits.body).toBe(200)
  })

  it('F3 refuses a joined address longer than its old column with 400 on the address fields', async () => {
    const familyId = await newFamily('LF F3 address')
    const member = await addMember(familyId, TYPES.uncle, 'Athree')
    const response = await app.inject({
      method: 'PUT',
      url: `/api/v1/contacts/${member.contactId}/addresses`,
      headers: auth,
      payload: { addresses: [{ type: 'home', line1: 'L'.repeat(200), line2: 'M'.repeat(60), city: 'Lakewood', isPrimary: true }] },
    })
    expect(response.statusCode, response.body).toBe(400)
    expect(response.json().code).toBe('VALIDATION')
    const paths = response.json().details.map((detail: { path: string }) => detail.path)
    expect(paths).toContain('/addresses/0/line1')
    expect(paths).toContain('/addresses/0/line2')
  })

  it('F3 refuses a householdPhone longer than the 30-character old home phone columns', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/families',
      headers: auth,
      payload: { name: 'LF F3 phone', householdPhone: '1'.repeat(31) },
    })
    expect(response.statusCode, response.body).toBe(400)
    expect(response.json().code).toBe('VALIDATION')
    if (response.statusCode === 200) {
      createdFamilies.push(Number(response.json().family.id))
    }
  })

  it('F4 sets strict sql_mode and a 10 s lock wait on every pool connection', async () => {
    const pooled = await app.db.getConnection()
    try {
      const [found] = await pooled.query<RowDataPacket[]>(
        `SELECT @@SESSION.sql_mode AS sqlMode, @@SESSION.innodb_lock_wait_timeout AS lockWait`,
      )
      expect(found[0]?.['sqlMode']).toBe('STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION')
      expect(Number(found[0]?.['lockWait'])).toBe(10)
    } finally {
      pooled.release()
    }
  })

  it('F5 never saves a new member with a type deactivated during the save (LOCK IN SHARE MODE)', async () => {
    const familyId = await newFamily('LF F5 target')
    const holder = await newFamily('LF F5 holder')
    const contact = await addMember(holder, TYPES.uncle, 'Cfive')
    const blocker = await adminConnection()
    try {
      await blocker.query('SET SESSION innodb_lock_wait_timeout = 10')
      await blocker.beginTransaction()
      await blocker.query(`SELECT id FROM family_contacts WHERE id = ? FOR UPDATE`, [contact.contactId])
      const pending = app.inject({
        method: 'POST',
        url: `/api/v1/families/${familyId}/members`,
        headers: auth,
        payload: { relationship: TYPES.cousin, contactId: contact.contactId },
      }).then((response) => response) // inject() is lazy until then() is called
      expect(await waitForLockWait()).toBe(true)
      let blockerFailed = false
      try {
        await blocker.query(`UPDATE relationship_types SET status = 'inactive' WHERE code = ?`, [TYPES.cousin])
      } catch {
        blockerFailed = true
      }
      if (blockerFailed) {
        await blocker.rollback()
      } else {
        await blocker.commit()
      }
      const response = await pending
      expect([200, 400]).toContain(response.statusCode)
      const [saved] = await connection.query<RowDataPacket[]>(
        `SELECT rt.status FROM family_members AS m INNER JOIN relationship_types AS rt ON rt.code = m.relationship
         WHERE m.family_id = ? AND m.family_contact_id = ?`,
        [familyId, contact.contactId],
      )
      if (response.statusCode === 200) {
        expect(saved[0]?.['status'], 'a member was saved with an inactive type').toBe('active')
      } else {
        expect(response.json().code).toBe('UNKNOWN_RELATIONSHIP')
        expect(saved).toHaveLength(0)
      }
    } finally {
      await blocker.end()
      await connection.query(`UPDATE relationship_types SET status = 'active' WHERE code = ?`, [TYPES.cousin])
    }
  }, 30_000)

  it('F5 check: deactivating a type waits for a share lock on its row (it takes FOR UPDATE)', async () => {
    const blocker = await adminConnection()
    try {
      await blocker.beginTransaction()
      await blocker.query(`SELECT code FROM relationship_types WHERE code = ? LOCK IN SHARE MODE`, [TYPES.locked])
      let done = false
      const pending = app
        .inject({
          method: 'PATCH',
          url: `/api/v1/relationship-types/${TYPES.locked}`,
          headers: auth,
          payload: { status: 'inactive' },
        })
        .then((response) => {
          done = true
          return response
        })
      expect(await waitForLockWait()).toBe(true)
      expect(done).toBe(false)
      await blocker.commit()
      const response = await pending
      expect(response.statusCode, response.body).toBe(200)
    } finally {
      await blocker.end()
    }
  }, 30_000)

  it('F6 answers a lock wait timeout with 503 RETRY and Retry-After: 2', async () => {
    const familyId = await newFamily('LF F6')
    const blocker = await adminConnection()
    let pending: Promise<Awaited<ReturnType<typeof app.inject>>> | undefined
    try {
      await blocker.beginTransaction()
      await blocker.query(`SELECT id FROM families WHERE id = ? FOR UPDATE`, [familyId])
      pending = app
        .inject({ method: 'PATCH', url: `/api/v1/families/${familyId}`, headers: auth, payload: { name: 'LF F6 renamed' } })
        .then((response) => response)
      const outcome = await Promise.race([pending, sleep(20_000).then(() => 'timeout' as const)])
      expect(outcome, 'the save waited longer than 20 s').not.toBe('timeout')
      if (outcome === 'timeout' || outcome === undefined) {
        return
      }
      expect(outcome.statusCode, outcome.body).toBe(503)
      expect(outcome.json().code).toBe('RETRY')
      expect(outcome.headers['retry-after']).toBe('2')
    } finally {
      await blocker.rollback()
      await blocker.end()
      await pending
    }
  }, 40_000)

  it('F7 accepts a PATCH that resends the member\'s own, now inactive, relationship', async () => {
    const familyId = await newFamily('LF F7')
    const nanny = await addMember(familyId, TYPES.nanny, 'Nseven')
    await connection.query(`UPDATE relationship_types SET status = 'inactive' WHERE code = ?`, [TYPES.nanny])
    try {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/families/${familyId}/members/${nanny.memberId}`,
        headers: auth,
        payload: { relationship: TYPES.nanny, sortOrder: 4 },
      })
      expect(response.statusCode, response.body).toBe(200)
      const changed = await app.inject({
        method: 'PATCH',
        url: `/api/v1/families/${familyId}/members/${nanny.memberId}`,
        headers: auth,
        payload: { relationship: TYPES.cousin },
      })
      expect(changed.statusCode, changed.body).toBe(200)
      const back = await app.inject({
        method: 'PATCH',
        url: `/api/v1/families/${familyId}/members/${nanny.memberId}`,
        headers: auth,
        payload: { relationship: TYPES.nanny },
      })
      expect(back.statusCode, back.body).toBe(400)
      expect(back.json().code).toBe('UNKNOWN_RELATIONSHIP')
    } finally {
      await connection.query(`UPDATE relationship_types SET status = 'active' WHERE code = ?`, [TYPES.nanny])
    }
  })

  it('F8 deletes a removed member\'s rights rows in the same transaction, audited; a re-added member has none', async () => {
    const familyId = await newFamily('LF F8')
    const father = await addMember(familyId, 'father', 'Feight')
    const mother = await addMember(familyId, 'mother', 'Meight')
    await setEmail(father.contactId, 'father8@logicfix.invalid')
    await setEmail(mother.contactId, 'mother8@logicfix.invalid')
    const childId = await unlinkedChild()
    await linkOk(familyId, childId)
    const rights = (memberId: number, payer: boolean) => ({
      memberId,
      receivesNotifications: true,
      notifyMethod: 'both',
      mayCollect: true,
      collectFrom: null,
      collectTo: null,
      isEmergency: false,
      isPaymentResponsible: payer,
    })
    const put = await app.inject({
      method: 'PUT',
      url: `/api/v1/families/${familyId}/children/${childId}/rights`,
      headers: auth,
      payload: { rights: [rights(father.memberId, false), rights(mother.memberId, true)] },
    })
    expect(put.statusCode, put.body).toBe(200)
    expect(await childColumn(childId, 'parent_email')).toBe('mother8@logicfix.invalid')
    const [before] = await connection.query<RowDataPacket[]>(
      `SELECT id FROM family_member_children WHERE member_id = ?`,
      [mother.memberId],
    )
    const rightsId = Number(before[0]?.['id'])

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/v1/families/${familyId}/members/${mother.memberId}`,
      headers: auth,
    })
    expect(removed.statusCode, removed.body).toBe(200)
    const [after] = await connection.query<RowDataPacket[]>(
      `SELECT id FROM family_member_children WHERE member_id = ?`,
      [mother.memberId],
    )
    expect(after).toHaveLength(0)
    const [audited] = await connection.query<RowDataPacket[]>(
      `SELECT col_name AS col FROM audit_logs WHERE table_name = 'family_member_children' AND table_id = ? AND action = 'delete'`,
      [rightsId],
    )
    expect(audited.map((row) => row['col'])).toContain('is_payment_responsible')

    const readded = await app.inject({
      method: 'POST',
      url: `/api/v1/families/${familyId}/members`,
      headers: auth,
      payload: { relationship: 'mother', contactId: mother.contactId },
    })
    expect(readded.statusCode, readded.body).toBe(200)
    const [revived] = await connection.query<RowDataPacket[]>(
      `SELECT id FROM family_member_children WHERE member_id = ?`,
      [mother.memberId],
    )
    expect(revived).toHaveLength(0)
    expect(await childColumn(childId, 'parent_email')).toBe('father8@logicfix.invalid')
    const [flag] = await connection.query<RowDataPacket[]>(
      `SELECT use_mother_phone_for_notification + 0 AS flag FROM children WHERE id = ?`,
      [childId],
    )
    expect(Number(flag[0]?.['flag'])).toBe(0)
  })

  it('F9 treats a stored NULL notification method as a change: preview, link and reconcile', async () => {
    const familyId = await newFamily('LF F9')
    await addMember(familyId, 'father', 'Fnine')
    const childId = await unlinkedChild()
    await connection.query(`UPDATE children SET notification_father_phone_method = NULL WHERE id = ?`, [childId])
    const preview = await app.inject({
      method: 'GET',
      url: `/api/v1/families/${familyId}/children/${childId}/preview`,
      headers: auth,
    })
    expect(preview.statusCode).toBe(200)
    const column = preview
      .json()
      .columns.find((row: { column: string }) => row.column === 'notification_father_phone_method')
    expect(column).toMatchObject({ today: null, after: 'voice', changed: true })
    const linked = await link(familyId, childId)
    expect(linked.statusCode, linked.body).toBe(200)
    expect(linked.json().affected_child_ids).toContain(childId)
    expect(await childColumn(childId, 'notification_father_phone_method')).toBe('voice')

    const pooled = await app.db.getConnection()
    try {
      await pooled.query('SET @family_mirror = 1')
      await pooled.query(`UPDATE children SET notification_father_phone_method = NULL WHERE id = ?`, [childId])
    } finally {
      await pooled.query('SET @family_mirror = NULL')
      pooled.release()
    }
    const report = await reconcileDatabase(app.db, { database: TEST_DATABASE, childId })
    expect(report.differences).toContainEqual({
      child: childId,
      column: 'notification_father_phone_method',
      stored: null,
      derived: 'voice',
    })
  })

  it('F10 lists only active households in GET /contacts?q=', async () => {
    const live = await newFamily('LF F10 live')
    const trashed = await newFamily('LF F10 trashed')
    const member = await addMember(live, TYPES.uncle, 'Zzyzxten')
    const joined = await app.inject({
      method: 'POST',
      url: `/api/v1/families/${trashed}/members`,
      headers: auth,
      payload: { relationship: TYPES.uncle, contactId: member.contactId },
    })
    expect(joined.statusCode, joined.body).toBe(200)
    const trash = await app.inject({ method: 'PATCH', url: `/api/v1/families/${trashed}`, headers: auth, payload: { status: 'trash' } })
    expect(trash.statusCode, trash.body).toBe(200)
    const search = await app.inject({ method: 'GET', url: '/api/v1/contacts?q=Zzyzxten', headers: auth })
    expect(search.statusCode).toBe(200)
    const item = search.json().items.find((row: { id: number }) => row.id === member.contactId)
    expect(item.households).toEqual([{ familyId: live, familyName: 'LF F10 live' }])
  })

  it('F11 compares staff types without case: an "Admin" list lets type admin in', async () => {
    const mixed = await buildApp({
      config: {
        ...config,
        db: { ...config.db, name: TEST_DATABASE },
        allowedStaffTypes: [' Admin ', 'OFFICE'],
        relationshipAdminTypes: ['ADMIN'],
      },
      logger: false,
    })
    try {
      const read = await mixed.inject({ method: 'GET', url: '/api/v1/relationship-types', headers: auth })
      expect(read.statusCode, read.body).toBe(200)
      const adminOnly = await mixed.inject({
        method: 'PATCH',
        url: '/api/v1/relationship-types/lf_missing',
        headers: auth,
        payload: { label: 'x' },
      })
      expect(adminOnly.statusCode, adminOnly.body).toBe(404)
    } finally {
      await mixed.close()
    }
  })

  it('F12 finds a phone from 7 to 9 digits by suffix, on member phones and the household phone', async () => {
    const familyId = await newFamily('LF F12', '(201) 937-4417')
    const member = await addMember(familyId, TYPES.uncle, 'Ptwelve')
    const phones = await app.inject({
      method: 'PUT',
      url: `/api/v1/contacts/${member.contactId}/phones`,
      headers: auth,
      payload: { phones: [{ phone: '(201) 937-4486', type: 'mobile', isPrimary: true }] },
    })
    expect(phones.statusCode, phones.body).toBe(200)
    const families = async (q: string) =>
      (await app.inject({ method: 'GET', url: `/api/v1/families?q=${encodeURIComponent(q)}&pageSize=100`, headers: auth }))
        .json()
        .items.map((row: { id: number }) => row.id)
    const contacts = async (q: string) =>
      (await app.inject({ method: 'GET', url: `/api/v1/contacts?q=${encodeURIComponent(q)}&pageSize=100`, headers: auth }))
        .json()
        .items.map((row: { id: number }) => row.id)
    expect(await families('937-4486')).toContain(familyId)
    expect(await families('19374486')).toContain(familyId)
    expect(await families('019374486')).toContain(familyId)
    expect(await families('937-4417')).toContain(familyId)
    expect(await contacts('9374486')).toContain(member.contactId)
    expect(await families('2019374486')).toContain(familyId)
    expect(await families('74486')).not.toContain(familyId)
  })

  it('F13 keeps row ids when id-less items match stored rows by value', async () => {
    const familyId = await newFamily('LF F13')
    const member = await addMember(familyId, TYPES.uncle, 'Lthirteen')
    const url = `/api/v1/contacts/${member.contactId}/phones`
    const first = await app.inject({
      method: 'PUT',
      url,
      headers: auth,
      payload: {
        phones: [
          { phone: '(201) 937-1301', type: 'mobile', isPrimary: true },
          { phone: '(201) 937-1302', type: 'work' },
        ],
      },
    })
    expect(first.statusCode, first.body).toBe(200)
    const ids = (first.json().contact.phones as { id: number; phone: string }[]).map((row) => [row.phone, row.id])
    const swapped = await app.inject({
      method: 'PUT',
      url,
      headers: auth,
      payload: {
        phones: [
          { phone: '201-937-1301', type: 'mobile' },
          { phone: '(201) 937-1302', type: 'work', isPrimary: true },
        ],
      },
    })
    expect(swapped.statusCode, swapped.body).toBe(200)
    const after = new Map((swapped.json().contact.phones as { id: number; phone: string }[]).map((row) => [row.id, row.phone]))
    expect([...after.keys()].sort()).toEqual(ids.map(([, id]) => id).sort())
    expect(after.get(Number(ids.find(([phone]) => phone === '(201) 937-1301')?.[1]))).toBe('201-937-1301')

    const emails = `/api/v1/contacts/${member.contactId}/emails`
    const e1 = await app.inject({ method: 'PUT', url: emails, headers: auth, payload: { emails: [{ email: 'Case@Logicfix.invalid', isPrimary: true }] } })
    const emailId = e1.json().contact.emails[0].id
    const e2 = await app.inject({ method: 'PUT', url: emails, headers: auth, payload: { emails: [{ email: ' case@logicfix.invalid', isPrimary: true, sortOrder: 3 }] } })
    expect(e2.statusCode, e2.body).toBe(200)
    expect(e2.json().contact.emails.map((row: { id: number }) => row.id)).toEqual([emailId])

    const addresses = `/api/v1/contacts/${member.contactId}/addresses`
    const a1 = await app.inject({
      method: 'PUT',
      url: addresses,
      headers: auth,
      payload: { addresses: [{ type: 'home', line1: '1 Logic Rd', city: 'Lakewood', isPrimary: true }] },
    })
    const addressId = a1.json().contact.addresses[0].id
    const a2 = await app.inject({
      method: 'PUT',
      url: addresses,
      headers: auth,
      payload: { addresses: [{ type: 'home', line1: '1 Logic Rd', city: 'Lakewood', isPrimary: true, typeLabel: null }] },
    })
    expect(a2.json().contact.addresses.map((row: { id: number }) => row.id)).toEqual([addressId])
  })

  it('F14 refuses a relationship code that does not start with a letter', async () => {
    for (const code of BAD_CODES) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/relationship-types',
        headers: auth,
        payload: { code, label: 'Bad', sortOrder: 1 },
      })
      expect(response.statusCode, `${code}: ${response.body}`).toBe(400)
    }
  })

  it('F18 makes the first active member the main contact, and promotes the next one when the main is removed', async () => {
    const familyId = await newFamily('LF F18')
    const uncle = await addMember(familyId, TYPES.uncle, 'Uighteen', { sortOrder: 0 })
    expect((await memberRow(uncle.memberId))?.['isPrimary']).toBe(1)
    const cousin = await addMember(familyId, TYPES.cousin, 'Cighteen', { sortOrder: 1 })
    const mother = await addMember(familyId, 'mother', 'Mighteen', { sortOrder: 5 })
    await setEmail(uncle.contactId, 'uncle18@logicfix.invalid')
    await setEmail(mother.contactId, 'mother18@logicfix.invalid')
    const childId = await unlinkedChild()
    await linkOk(familyId, childId)
    expect(await childColumn(childId, 'parent_email')).toBe('uncle18@logicfix.invalid')

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/v1/families/${familyId}/members/${uncle.memberId}`,
      headers: auth,
    })
    expect(removed.statusCode, removed.body).toBe(200)
    expect((await memberRow(mother.memberId))?.['isPrimary']).toBe(1)
    expect((await memberRow(cousin.memberId))?.['isPrimary']).toBe(0)
    expect(await childColumn(childId, 'parent_email')).toBe('mother18@logicfix.invalid')
    const [audited] = await connection.query<RowDataPacket[]>(
      `SELECT old_value AS oldValue, new_value AS newValue FROM audit_logs
       WHERE table_name = 'family_members' AND table_id = ? AND col_name = 'is_primary'`,
      [mother.memberId],
    )
    expect(audited).toContainEqual({ oldValue: '0', newValue: '1' })
    const [mains] = await connection.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS mains FROM family_members WHERE family_id = ? AND status = 'active' AND is_primary = 1`,
      [familyId],
    )
    expect(Number(mains[0]?.['mains'])).toBe(1)
  })

  it('F19 refuses a list with the same phone or email twice (400 DUPLICATE_ITEM with the paths)', async () => {
    const familyId = await newFamily('LF F19')
    const member = await addMember(familyId, TYPES.uncle, 'Dnineteen')
    const phones = await app.inject({
      method: 'PUT',
      url: `/api/v1/contacts/${member.contactId}/phones`,
      headers: auth,
      payload: {
        phones: [
          { phone: '(201) 937-1901', type: 'mobile', isPrimary: true },
          { phone: '+1 201.937.1902', type: 'home' },
          { phone: '201-937-1901', type: 'work' },
        ],
      },
    })
    expect(phones.statusCode, phones.body).toBe(400)
    expect(phones.json().code).toBe('DUPLICATE_ITEM')
    expect(phones.json().details.map((detail: { path: string }) => detail.path)).toEqual(['/phones/0/phone', '/phones/2/phone'])
    const emails = await app.inject({
      method: 'PUT',
      url: `/api/v1/contacts/${member.contactId}/emails`,
      headers: auth,
      payload: { emails: [{ email: 'Dup@Logicfix.invalid', isPrimary: true }, { email: 'dup@logicfix.invalid' }] },
    })
    expect(emails.statusCode, emails.body).toBe(400)
    expect(emails.json().code).toBe('DUPLICATE_ITEM')
    expect(emails.json().details.map((detail: { path: string }) => detail.path)).toEqual(['/emails/0/email', '/emails/1/email'])
  })
})

async function cleanUp(): Promise<void> {
  const list = (ids: readonly unknown[]) => ids.map(() => '?').join(', ')
  // Unlink through the API so the triggers stay quiet, then give each child its stored values back.
  for (const [childId, snapshot] of snapshots) {
    if ((await familyIdOf(childId)) !== null) {
      await app.inject({ method: 'POST', url: `/api/v1/children/${childId}/unlink`, headers: auth })
    }
    const childColumns = Object.keys(snapshot.children)
    await connection.query(
      `UPDATE children SET ${childColumns.map((column) => `${quoteIdentifier(column)} = ?`).join(', ')} WHERE id = ?`,
      [...childColumns.map((column) => snapshot.children[column]), childId],
    )
    if (snapshot.additional === null) {
      await connection.query(`DELETE FROM children_additional_information WHERE child_id = ?`, [childId])
    } else {
      const additionalColumns = Object.keys(snapshot.additional)
      await connection.query(
        `UPDATE children_additional_information
         SET ${additionalColumns.map((column) => `${quoteIdentifier(column)} = ?`).join(', ')} WHERE child_id = ?`,
        [...additionalColumns.map((column) => snapshot.additional?.[column]), childId],
      )
    }
  }
  if (createdFamilies.length > 0) {
    await connection.query(
      `DELETE r FROM family_member_children AS r INNER JOIN family_members AS m ON m.id = r.member_id
       WHERE m.family_id IN (${list(createdFamilies)})`,
      createdFamilies,
    )
    await connection.query(`DELETE FROM family_members WHERE family_id IN (${list(createdFamilies)})`, createdFamilies)
  }
  if (createdContacts.length > 0) {
    for (const table of ['family_contact_phones', 'family_contact_emails', 'family_contact_addresses']) {
      await connection.query(
        `DELETE FROM ${quoteIdentifier(table)} WHERE family_contact_id IN (${list(createdContacts)})`,
        createdContacts,
      )
    }
    await connection.query(`DELETE FROM family_contacts WHERE id IN (${list(createdContacts)})`, createdContacts)
  }
  if (createdFamilies.length > 0) {
    await connection.query(`DELETE FROM families WHERE id IN (${list(createdFamilies)})`, createdFamilies)
  }
  const codes = [...Object.values(TYPES), ...BAD_CODES]
  await connection.query(`DELETE FROM relationship_types WHERE code IN (${list(codes)})`, codes)
  await connection.query(`DELETE FROM audit_logs WHERE id > ?`, [auditMark])
  await connection.query(`DELETE FROM record_audit WHERE id > ?`, [recordMark])
}
