import type { RowDataPacket } from 'mysql2/promise'
import mysql from 'mysql2/promise'
import { afterAll, describe, expect, it } from 'vitest'
import { quoteIdentifier } from '../../src/lib/sql.js'
import { buildApp } from '../../src/app.js'
import { loadConfig } from '../../src/config/env.js'
import { ADDITIONAL_MIRROR_COLUMNS, CHILDREN_MIRROR_COLUMNS } from '../../src/modules/family/services/mirror/types.js'
import { issueDevToken, revokeDevTokens } from '../../scripts/dev-token.js'
import { loadAdminConfig } from '../../scripts/mariadb-admin.js'
import { asFamilyApi, unlinkWithFlag } from '../helpers/lock.js'

const TEST_DATABASE = 'tendi_family_test'
const BIT_COLUMNS = new Set(['use_father_phone_for_notification', 'use_mother_phone_for_notification'])

interface PhoneInput {
  phone: string
  type: string
  typeLabel: string | null
  channel: string
  isPrimary: boolean
  sortOrder: number
}

interface ChildSnapshot {
  id: number
  familyId: number | null
  children: Record<string, string | number | null>
  additional: Record<string, string | number | null>
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
const [spareTypeRows] = await connection.query<RowDataPacket[]>(
  `SELECT code FROM relationship_types WHERE status = 'active' AND parent_slot IS NULL ORDER BY sort_order, code LIMIT 1`,
)
const spareType = String(spareTypeRows[0]?.['code'] ?? '')
if (spareType === '') {
  throw new Error('tendi_family_test has no non-parent relationship type.')
}
const token = await issueDevToken(connection, adminId)
const config = await loadConfig()
const app = await buildApp({
  config: { ...config, db: { ...config.db, name: TEST_DATABASE } },
  logger: false,
})

const createdFamilies: number[] = []
const createdContacts: number[] = []
const borrowed: ChildSnapshot[] = []
let restoreSiblingPhones: (() => Promise<void>) | null = null
let restoreHousehold: { familyId: number; phone: string } | null = null

describe('family writes', () => {
  const auth = { authorization: `Bearer ${token}` }

  afterAll(async () => {
    if (restoreSiblingPhones !== null) {
      await restoreSiblingPhones()
      restoreSiblingPhones = null
    }
    if (restoreHousehold !== null) {
      await app.inject({
        method: 'PATCH',
        url: `/api/v1/families/${restoreHousehold.familyId}`,
        headers: auth,
        payload: { householdPhone: restoreHousehold.phone },
      })
      restoreHousehold = null
    }
    await restoreBorrowed()
    await connection.query(`UPDATE relationship_types SET status = 'active' WHERE code = ?`, [spareType])
    await deleteCreated()
    await revokeDevTokens(connection, adminId)
    await connection.end()
    await app.close()
  })

  it('creates, updates, and trashes a family, and audits each column', async () => {
    const created = await postFamily('B6 Household')
    expect(created.affected_child_ids).toEqual([])
    expect(created.family).toMatchObject({ name: 'B6 Household', householdPhone: '', status: 'active' })
    createdFamilies.push(created.family.id)

    const [audit] = await connection.query<RowDataPacket[]>(
      `SELECT action, col_name, old_value, new_value, actor_type, actor_ref, type
       FROM audit_logs WHERE table_name = 'families' AND table_id = ? ORDER BY id`,
      [created.family.id],
    )
    expect(audit.map((row) => row['col_name'])).toEqual(['name', 'household_phone', 'status'])
    expect(audit.every((row) => row['action'] === 'insert' && row['actor_type'] === 'staff')).toBe(true)
    expect(audit.every((row) => row['actor_ref'] === 'tendi-new' && row['type'] === 'family')).toBe(true)
    expect(audit.find((row) => row['col_name'] === 'name')?.['new_value']).toBe('B6 Household')

    const renamed = await app.inject({
      method: 'PATCH',
      url: `/api/v1/families/${created.family.id}`,
      headers: auth,
      payload: { name: 'B6 Household Renamed', householdPhone: '5550100' },
    })
    expect(renamed.statusCode).toBe(200)
    expect(renamed.json().family).toMatchObject({ name: 'B6 Household Renamed', householdPhone: '5550100' })

    const empty = await app.inject({
      method: 'PATCH',
      url: `/api/v1/families/${created.family.id}`,
      headers: auth,
      payload: {},
    })
    expect(empty.statusCode).toBe(400)
    expect(empty.json().code).toBe('VALIDATION')

    const trashed = await app.inject({
      method: 'PATCH',
      url: `/api/v1/families/${created.family.id}`,
      headers: auth,
      payload: { status: 'trash' },
    })
    expect(trashed.statusCode).toBe(200)
    expect(trashed.json().family.status).toBe('trash')
    const hidden = await app.inject({
      method: 'GET',
      url: `/api/v1/families/${created.family.id}`,
      headers: auth,
    })
    expect(hidden.statusCode).toBe(404)

    const missing = await app.inject({
      method: 'PATCH',
      url: '/api/v1/families/999999999',
      headers: auth,
      payload: { name: 'Nope' },
    })
    expect(missing.statusCode).toBe(404)
  })

  it('adds, revives, and removes members, and rejects a bad relationship', async () => {
    const created = await postFamily('B6 Members')
    createdFamilies.push(created.family.id)
    const familyId = created.family.id

    const added = await app.inject({
      method: 'POST',
      url: `/api/v1/families/${familyId}/members`,
      headers: auth,
      payload: {
        relationship: 'father',
        isPrimary: true,
        contact: { fname: 'B6', lname: 'Father', occupation: 'teacher' },
      },
    })
    expect(added.statusCode).toBe(200)
    const father = added.json().family.members[0]
    // A new contact stores the legacy format: the first name only.
    expect(father.contact.legacyFullName).toBe('B6')
    expect(father.isPrimary).toBe(true)
    createdContacts.push(father.contact.id)
    const memberId = father.id

    const other = await app.inject({
      method: 'POST',
      url: `/api/v1/families/${familyId}/members`,
      headers: auth,
      payload: { relationship: spareType, contact: { fname: 'B6', lname: 'Aunt' } },
    })
    expect(other.statusCode).toBe(200)
    const aunt = other.json().family.members.find((member: { contact: { lname: string } }) => member.contact.lname === 'Aunt')
    createdContacts.push(aunt.contact.id)

    const primary = await app.inject({
      method: 'PATCH',
      url: `/api/v1/families/${familyId}/members/${aunt.id}`,
      headers: auth,
      payload: { isPrimary: true },
    })
    expect(primary.statusCode).toBe(200)
    const members = primary.json().family.members
    expect(members.find((member: { id: number }) => member.id === aunt.id).isPrimary).toBe(true)
    expect(members.find((member: { id: number }) => member.id === memberId).isPrimary).toBe(false)

    const duplicate = await app.inject({
      method: 'POST',
      url: `/api/v1/families/${familyId}/members`,
      headers: auth,
      payload: { relationship: 'father', contactId: father.contact.id },
    })
    expect(duplicate.statusCode).toBe(409)
    expect(duplicate.json().code).toBe('ALREADY_MEMBER')

    const unknownType = await app.inject({
      method: 'POST',
      url: `/api/v1/families/${familyId}/members`,
      headers: auth,
      payload: { relationship: 'not-a-type', contact: { fname: 'B6', lname: 'Nope' } },
    })
    expect(unknownType.statusCode).toBe(400)
    expect(unknownType.json().code).toBe('UNKNOWN_RELATIONSHIP')

    await connection.query(`UPDATE relationship_types SET status = 'inactive' WHERE code = ?`, [spareType])
    const inactive = await app.inject({
      method: 'POST',
      url: `/api/v1/families/${familyId}/members`,
      headers: auth,
      payload: { relationship: spareType, contact: { fname: 'B6', lname: 'Nope' } },
    })
    expect(inactive.statusCode).toBe(400)
    expect(inactive.json().code).toBe('UNKNOWN_RELATIONSHIP')
    await connection.query(`UPDATE relationship_types SET status = 'active' WHERE code = ?`, [spareType])

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/v1/families/${familyId}/members/${memberId}`,
      headers: auth,
    })
    expect(removed.statusCode).toBe(200)
    expect(removed.json().family.members.some((member: { id: number }) => member.id === memberId)).toBe(false)

    const revived = await app.inject({
      method: 'POST',
      url: `/api/v1/families/${familyId}/members`,
      headers: auth,
      payload: { relationship: 'mother', contactId: father.contact.id },
    })
    expect(revived.statusCode).toBe(200)
    const revivedMember = revived.json().family.members.find(
      (member: { contact: { id: number } }) => member.contact.id === father.contact.id,
    )
    expect(revivedMember.id).toBe(memberId)
    expect(revivedMember.relationship).toBe('mother')

    const missingMember = await app.inject({
      method: 'PATCH',
      url: `/api/v1/families/${familyId}/members/999999999`,
      headers: auth,
      payload: { sortOrder: 3 },
    })
    expect(missingMember.statusCode).toBe(404)
  })

  it('replaces phones, emails, and addresses, and keeps a legacy name that is in neither format', async () => {
    const created = await postFamily('B6 Channels')
    createdFamilies.push(created.family.id)
    const added = await app.inject({
      method: 'POST',
      url: `/api/v1/families/${created.family.id}/members`,
      headers: auth,
      payload: { relationship: 'father', contact: { fname: 'B6', lname: 'Named' } },
    })
    expect(added.statusCode).toBe(200)
    const contactId = added.json().family.members[0].contact.id
    createdContacts.push(contactId)

    await connection.query(`UPDATE family_contacts SET legacy_full_name = 'Kept Name' WHERE id = ?`, [contactId])
    const noted = await app.inject({
      method: 'PATCH',
      url: `/api/v1/contacts/${contactId}`,
      headers: auth,
      payload: { note: 'a note' },
    })
    expect(noted.statusCode).toBe(200)
    expect(noted.json().contact.legacyFullName).toBe('Kept Name')
    expect(noted.json().contact.note).toBe('a note')

    const renamed = await app.inject({
      method: 'PATCH',
      url: `/api/v1/contacts/${contactId}`,
      headers: auth,
      payload: { fname: 'B6b' },
    })
    expect(renamed.statusCode).toBe(200)
    // 'Kept Name' is neither the first name nor "fname lname", so a name change leaves it as it is.
    expect(renamed.json().contact.fname).toBe('B6b')
    expect(renamed.json().contact.legacyFullName).toBe('Kept Name')

    const twoPrimaries = await app.inject({
      method: 'PUT',
      url: `/api/v1/contacts/${contactId}/phones`,
      headers: auth,
      payload: {
        phones: [
          { phone: '2125550101', isPrimary: true },
          { phone: '2125550102', isPrimary: true },
        ],
      },
    })
    expect(twoPrimaries.statusCode).toBe(409)
    expect(twoPrimaries.json().code).toBe('SECOND_PRIMARY')

    const noPrimary = await app.inject({
      method: 'PUT',
      url: `/api/v1/contacts/${contactId}/phones`,
      headers: auth,
      payload: { phones: [{ phone: '2125550101', isPrimary: false }] },
    })
    expect(noPrimary.statusCode).toBe(400)
    expect(noPrimary.json().code).toBe('PRIMARY_REQUIRED')

    const labeled = await app.inject({
      method: 'PUT',
      url: `/api/v1/contacts/${contactId}/phones`,
      headers: auth,
      payload: { phones: [{ phone: '2125550101', type: 'mobile', typeLabel: 'cell', isPrimary: true }] },
    })
    expect(labeled.statusCode).toBe(400)
    expect(labeled.json().code).toBe('TYPE_LABEL_NOT_ALLOWED')

    const generated = await app.inject({
      method: 'PUT',
      url: `/api/v1/contacts/${contactId}/phones`,
      headers: auth,
      payload: { phones: [{ phone: '2125550101', isPrimary: true, phoneNormalized: '2125550101' }] },
    })
    expect(generated.statusCode).toBe(400)
    expect(generated.json().code).toBe('VALIDATION')

    const phones = await app.inject({
      method: 'PUT',
      url: `/api/v1/contacts/${contactId}/phones`,
      headers: auth,
      payload: {
        phones: [
          { phone: '(212) 555-0101', type: 'mobile', isPrimary: true, sortOrder: 1 },
          { phone: '555-0199', type: 'other', typeLabel: '  school office  ', channel: 'voice', sortOrder: 2 },
        ],
      },
    })
    expect(phones.statusCode).toBe(200)
    expect(phones.json().contact.phones).toEqual([
      expect.objectContaining({
        phone: '(212) 555-0101',
        type: 'mobile',
        typeLabel: null,
        channel: 'sms',
        isPrimary: true,
        sortOrder: 1,
      }),
      expect.objectContaining({
        phone: '555-0199',
        type: 'other',
        typeLabel: 'school office',
        channel: 'voice',
        isPrimary: false,
        sortOrder: 2,
      }),
    ])

    const emails = await app.inject({
      method: 'PUT',
      url: `/api/v1/contacts/${contactId}/emails`,
      headers: auth,
      payload: { emails: [{ email: 'b6@example.invalid', isPrimary: true }] },
    })
    expect(emails.statusCode).toBe(200)
    expect(emails.json().contact.emails).toEqual([
      expect.objectContaining({ email: 'b6@example.invalid', type: 'personal', isPrimary: true }),
    ])

    const addresses = await app.inject({
      method: 'PUT',
      url: `/api/v1/contacts/${contactId}/addresses`,
      headers: auth,
      payload: { addresses: [{ line1: '1 Test Road', city: 'Brooklyn', state: 'NY', zip: '11201', isPrimary: true }] },
    })
    expect(addresses.statusCode).toBe(200)
    expect(addresses.json().contact.addresses).toEqual([
      expect.objectContaining({ type: 'home', line1: '1 Test Road', city: 'Brooklyn', isPrimary: true }),
    ])

    const cleared = await app.inject({
      method: 'PUT',
      url: `/api/v1/contacts/${contactId}/phones`,
      headers: auth,
      payload: { phones: [] },
    })
    expect(cleared.statusCode).toBe(200)
    expect(cleared.json().contact.phones).toEqual([])
  })

  it('keeps row ids across a list save and audits only what changed', async () => {
    const created = await postFamily('B12 Lists')
    createdFamilies.push(created.family.id)
    const added = await app.inject({
      method: 'POST',
      url: `/api/v1/families/${created.family.id}/members`,
      headers: auth,
      payload: { relationship: spareType, contact: { fname: 'B12', lname: 'Lists' } },
    })
    expect(added.statusCode).toBe(200)
    const contactId = added.json().family.members[0].contact.id
    createdContacts.push(contactId)
    const put = (phones: unknown[]) =>
      app.inject({ method: 'PUT', url: `/api/v1/contacts/${contactId}/phones`, headers: auth, payload: { phones } })
    const listed = [
      { phone: '2125550111', type: 'mobile', isPrimary: true, sortOrder: 1 },
      { phone: '2125550112', type: 'work', sortOrder: 2 },
    ]

    try {
      const first = await put(listed)
      expect(first.statusCode).toBe(200)
      type Phone = { id: number; phone: string; isPrimary: boolean }
      const firstPhones = first.json().contact.phones as Phone[]
      const mobile = firstPhones.find((phone) => phone.phone === '2125550111')
      const work = firstPhones.find((phone) => phone.phone === '2125550112')
      if (mobile === undefined || work === undefined) {
        throw new Error('The saved phones are missing.')
      }
      const auditRows = async () => {
        const [found] = await connection.query<RowDataPacket[]>(
          `SELECT action, col_name, table_id FROM audit_logs
           WHERE table_name = 'family_contact_phones' AND table_id IN (?, ?) ORDER BY id`,
          [mobile.id, work.id],
        )
        return found
      }
      const afterFirst = (await auditRows()).length

      const same = await put(listed)
      expect(same.statusCode).toBe(200)
      expect((same.json().contact.phones as Phone[]).map((phone) => phone.id).sort()).toEqual([mobile.id, work.id].sort())
      expect((await auditRows()).length).toBe(afterFirst)

      const swapped = await put([
        { id: mobile.id, phone: '2125550111', type: 'mobile', isPrimary: false, sortOrder: 1 },
        { id: work.id, phone: '2125550112', type: 'work', isPrimary: true, sortOrder: 2 },
      ])
      expect(swapped.statusCode).toBe(200)
      const swappedPhones = swapped.json().contact.phones as Phone[]
      expect(swappedPhones.find((phone) => phone.id === work.id)?.isPrimary).toBe(true)
      expect(swappedPhones.find((phone) => phone.id === mobile.id)?.isPrimary).toBe(false)
      const swapAudit = (await auditRows()).slice(afterFirst)
      expect(swapAudit.map((row) => [row['action'], row['col_name'], Number(row['table_id'])]).sort()).toEqual(
        [
          ['update', 'is_primary', mobile.id],
          ['update', 'is_primary', work.id],
        ].sort(),
      )

      const unknown = await put([{ id: 999999999, phone: '2125550111', isPrimary: true }])
      expect(unknown.statusCode).toBe(400)
      expect(unknown.json().code).toBe('VALIDATION')

      const twice = await put([
        { id: mobile.id, phone: '2125550111', isPrimary: true },
        { id: mobile.id, phone: '2125550113' },
      ])
      expect(twice.statusCode).toBe(400)
      expect(twice.json().code).toBe('VALIDATION')
    } finally {
      expect((await put([])).statusCode).toBe(200)
    }
  })

  it('refuses to trash a family that still has linked children', async () => {
    const [linkedRows] = await connection.query<RowDataPacket[]>(
      `SELECT family_id AS familyId FROM children WHERE family_id IS NOT NULL ORDER BY family_id LIMIT 1`,
    )
    const familyId = Number(linkedRows[0]?.['familyId'])
    const refused = await app.inject({
      method: 'PATCH',
      url: `/api/v1/families/${familyId}`,
      headers: auth,
      payload: { status: 'trash' },
    })
    expect(refused.statusCode).toBe(409)
    expect(refused.json().code).toBe('HAS_LINKED_CHILDREN')
    expect(refused.json().details.childIds.length).toBeGreaterThan(0)
    const [status] = await connection.query<RowDataPacket[]>(`SELECT status FROM families WHERE id = ?`, [familyId])
    expect(status[0]?.['status']).toBe('active')
  })

  it('updates every linked sibling when a father mobile changes, and rolls back a value that does not fit', async () => {
    const sample = await siblingFather()
    const beforePhones = await phoneRows(sample.contactId)
    const beforeChildren = await childPhones(sample.familyId)
    expect(beforeChildren.length).toBeGreaterThan(1)

    const tooLong = await app.inject({
      method: 'PUT',
      url: `/api/v1/contacts/${sample.contactId}/phones`,
      headers: auth,
      payload: { phones: [{ phone: '1'.repeat(31), type: 'home', isPrimary: true }] },
    })
    // F3: a phone longer than the 30-character *_home_phone / *_office_phone columns is refused by the schema
    // before the save starts (it used to reach the mirror and roll back with 409 VALUE_TOO_LONG).
    expect(tooLong.statusCode).toBe(400)
    expect(tooLong.json().code).toBe('VALIDATION')
    expect(tooLong.json().details.map((detail: { path: string }) => detail.path)).toContain('/phones/0/phone')
    expect(await phoneRows(sample.contactId)).toEqual(beforePhones)
    expect(await childPhones(sample.familyId)).toEqual(beforeChildren)

    const nextPhone = '(999) 555-0199'
    const changed = await app.inject({
      method: 'PUT',
      url: `/api/v1/contacts/${sample.contactId}/phones`,
      headers: auth,
      payload: { phones: [{ phone: nextPhone, type: 'mobile', isPrimary: true }] },
    })
    expect(changed.statusCode).toBe(200)
    restoreSiblingPhones = async () => {
      await replacePhones(sample.contactId, beforePhones)
    }
    const body = changed.json()
    const after = await childPhones(sample.familyId)
    expect(after.every((row) => row.fatherPhone === nextPhone)).toBe(true)
    for (const row of after) {
      expect(body.affected_child_ids).toContain(row.id)
    }

    const household = String(
      (
        await connection.query<RowDataPacket[]>(`SELECT household_phone AS phone FROM families WHERE id = ?`, [
          sample.familyId,
        ])
      )[0][0]?.['phone'] ?? '',
    )
    const householdPhone = household === '9995550100' ? '9995550101' : '9995550100'
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/v1/families/${sample.familyId}`,
      headers: auth,
      payload: { householdPhone },
    })
    expect(patched.statusCode).toBe(200)
    restoreHousehold = { familyId: sample.familyId, phone: household }
    const homes = await connection.query<RowDataPacket[]>(
      `SELECT home_phone AS homePhone FROM children WHERE family_id = ? AND status <> 'trash'`,
      [sample.familyId],
    )
    expect(homes[0].every((row) => row['homePhone'] === householdPhone)).toBe(true)
  })

  it('re-mirrors the linked children of both households when one contact changes', async () => {
    const shared = await sharedFather()
    if (shared !== null) {
      const before = await phoneRows(shared.contactId)
      const marker = '(999) 555-0188'
      const changed = await app.inject({
        method: 'PUT',
        url: `/api/v1/contacts/${shared.contactId}/phones`,
        headers: auth,
        payload: { phones: [{ phone: marker, type: 'mobile', isPrimary: true }] },
      })
      expect(changed.statusCode).toBe(200)
      try {
        const body = changed.json()
        for (const childId of shared.childIds) {
          expect(body.affected_child_ids).toContain(childId)
          const [rows] = await connection.query<RowDataPacket[]>(
            `SELECT father_phone AS fatherPhone FROM children WHERE id = ?`,
            [childId],
          )
          expect(rows[0]?.['fatherPhone']).toBe(marker)
        }
      } finally {
        await replacePhones(shared.contactId, before)
      }
      return
    }

    const first = await postFamily('B6 Left')
    const second = await postFamily('B6 Right')
    createdFamilies.push(first.family.id, second.family.id)
    const added = await app.inject({
      method: 'POST',
      url: `/api/v1/families/${first.family.id}/members`,
      headers: auth,
      payload: { relationship: 'father', isPrimary: true, contact: { fname: 'B6', lname: 'Shared' } },
    })
    expect(added.statusCode).toBe(200)
    const contactId = added.json().family.members[0].contact.id
    createdContacts.push(contactId)
    const joined = await app.inject({
      method: 'POST',
      url: `/api/v1/families/${second.family.id}/members`,
      headers: auth,
      payload: { relationship: 'father', isPrimary: true, contactId },
    })
    expect(joined.statusCode).toBe(200)

    const children = await unlinkedChildren()
    expect(children).toHaveLength(2)
    const snapshots = await Promise.all(children.map((childId) => snapshotChild(childId)))
    borrowed.push(...snapshots)
    // Revision 4 puts back a family_id change from root, so the fixture links as family_api with the flag.
    await asFamilyApi(app.db, async (familyApi) => {
      await familyApi.query(`UPDATE children SET family_id = ? WHERE id = ?`, [first.family.id, children[0]])
      await familyApi.query(`UPDATE children SET family_id = ? WHERE id = ?`, [second.family.id, children[1]])
    })

    const changed = await app.inject({
      method: 'PUT',
      url: `/api/v1/contacts/${contactId}/phones`,
      headers: auth,
      payload: { phones: [{ phone: '(999) 555-0177', type: 'mobile', isPrimary: true }] },
    })
    expect(changed.statusCode).toBe(200)
    const body = changed.json()
    expect(body.affected_child_ids).toEqual(expect.arrayContaining(children))
    for (const childId of children) {
      const [rows] = await connection.query<RowDataPacket[]>(
        `SELECT father_phone AS fatherPhone FROM children WHERE id = ?`,
        [childId],
      )
      expect(rows[0]?.['fatherPhone']).toBe('(999) 555-0177')
    }
    await restoreBorrowed()
  })

  async function postFamily(name: string) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/families',
      headers: auth,
      payload: { name },
    })
    expect(response.statusCode).toBe(200)
    return response.json()
  }

  async function siblingFather(): Promise<{ familyId: number; contactId: number }> {
    const [rows] = await connection.query<RowDataPacket[]>(
      `SELECT f.id AS familyId, m.family_contact_id AS contactId
       FROM families AS f
       INNER JOIN family_members AS m ON m.family_id = f.id AND m.status = 'active'
       INNER JOIN family_contacts AS fc ON fc.id = m.family_contact_id AND fc.status = 'active'
       INNER JOIN relationship_types AS rt ON rt.code = m.relationship AND rt.parent_slot = 'father' AND rt.slot_rank = 1
       INNER JOIN children AS c ON c.family_id = f.id AND c.status <> 'trash'
       WHERE f.status = 'active'
       GROUP BY f.id, m.family_contact_id
       HAVING COUNT(c.id) >= 2
       ORDER BY f.id
       LIMIT 1`,
    )
    const row = rows[0]
    if (row === undefined) {
      throw new Error('tendi_family_test has no father with two linked children.')
    }
    return { familyId: Number(row['familyId']), contactId: Number(row['contactId']) }
  }

  async function sharedFather(): Promise<{ contactId: number; childIds: number[] } | null> {
    const [contacts] = await connection.query<RowDataPacket[]>(
      `SELECT m.family_contact_id AS contactId
       FROM family_members AS m
       INNER JOIN relationship_types AS rt
         ON rt.code = m.relationship AND rt.parent_slot = 'father' AND rt.slot_rank = 1
       INNER JOIN children AS c ON c.family_id = m.family_id AND c.status <> 'trash'
       WHERE m.status = 'active'
       GROUP BY m.family_contact_id
       HAVING COUNT(DISTINCT m.family_id) >= 2
       ORDER BY m.family_contact_id
       LIMIT 1`,
    )
    const contact = contacts[0]
    if (contact === undefined) {
      return null
    }
    const contactId = Number(contact['contactId'])
    const [children] = await connection.query<RowDataPacket[]>(
      `SELECT DISTINCT c.id AS id
       FROM family_members AS m
       INNER JOIN children AS c ON c.family_id = m.family_id AND c.status <> 'trash'
       WHERE m.family_contact_id = ? AND m.status = 'active'
       ORDER BY c.id`,
      [contactId],
    )
    return { contactId, childIds: children.map((row) => Number(row['id'])) }
  }

  async function phoneRows(contactId: number): Promise<PhoneInput[]> {
    const [rows] = await connection.query<RowDataPacket[]>(
      `SELECT phone, type, type_label AS typeLabel, channel, is_primary AS isPrimary, sort_order AS sortOrder
       FROM family_contact_phones WHERE family_contact_id = ? ORDER BY sort_order, id`,
      [contactId],
    )
    return rows.map((row) => ({
      phone: String(row['phone']),
      type: String(row['type']),
      typeLabel: row['typeLabel'] === null ? null : String(row['typeLabel']),
      channel: String(row['channel']),
      isPrimary: Number(row['isPrimary']) === 1,
      sortOrder: Number(row['sortOrder']),
    }))
  }

  async function replacePhones(contactId: number, phones: PhoneInput[]): Promise<void> {
    const response = await app.inject({
      method: 'PUT',
      url: `/api/v1/contacts/${contactId}/phones`,
      headers: auth,
      payload: { phones },
    })
    if (response.statusCode !== 200) {
      throw new Error(`Could not restore phones for contact ${contactId}: ${response.body}`)
    }
  }

  async function childPhones(familyId: number): Promise<{ id: number; fatherPhone: string; homePhone: string; fatherHomePhone: string | null }[]> {
    const [rows] = await connection.query<RowDataPacket[]>(
      `SELECT c.id, c.father_phone AS fatherPhone, c.home_phone AS homePhone, a.father_home_phone AS fatherHomePhone
       FROM children AS c
       LEFT JOIN children_additional_information AS a ON a.child_id = c.id
       WHERE c.family_id = ? AND c.status <> 'trash'
       ORDER BY c.id`,
      [familyId],
    )
    return rows.map((row) => ({
      id: Number(row['id']),
      fatherPhone: String(row['fatherPhone']),
      homePhone: String(row['homePhone']),
      fatherHomePhone: row['fatherHomePhone'] === null ? null : String(row['fatherHomePhone']),
    }))
  }

  async function unlinkedChildren(): Promise<number[]> {
    const [rows] = await connection.query<RowDataPacket[]>(
      `SELECT c.id
       FROM children AS c
       INNER JOIN children_additional_information AS a ON a.child_id = c.id
       WHERE c.family_id IS NULL AND c.status <> 'trash'
       ORDER BY c.id
       LIMIT 2`,
    )
    return rows.map((row) => Number(row['id']))
  }
})

async function snapshotChild(childId: number): Promise<ChildSnapshot> {
  const [children] = await connection.query<RowDataPacket[]>(
    `SELECT family_id AS familyId, ${selectList(CHILDREN_MIRROR_COLUMNS)} FROM children WHERE id = ?`,
    [childId],
  )
  const [additional] = await connection.query<RowDataPacket[]>(
    `SELECT ${selectList(ADDITIONAL_MIRROR_COLUMNS)} FROM children_additional_information WHERE child_id = ?`,
    [childId],
  )
  const child = children[0]
  const extra = additional[0]
  if (child === undefined || extra === undefined) {
    throw new Error(`Child ${childId} is missing a row the test can restore.`)
  }
  return {
    id: childId,
    familyId: child['familyId'] === null ? null : Number(child['familyId']),
    children: recordOf(CHILDREN_MIRROR_COLUMNS, child),
    additional: recordOf(ADDITIONAL_MIRROR_COLUMNS, extra),
  }
}

async function restoreBorrowed(): Promise<void> {
  for (const child of borrowed) {
    if (child.familyId !== null) {
      throw new Error(`Child ${child.id} was linked when borrowed. This fixture only puts children back to unlinked.`)
    }
    await unlinkWithFlag(connection, child.id)
    await connection.query(
      `UPDATE children SET ${assignments(CHILDREN_MIRROR_COLUMNS)} WHERE id = ?`,
      [...values(CHILDREN_MIRROR_COLUMNS, child.children), child.id],
    )
    await connection.query(
      `UPDATE children_additional_information SET ${assignments(ADDITIONAL_MIRROR_COLUMNS)} WHERE child_id = ?`,
      [...values(ADDITIONAL_MIRROR_COLUMNS, child.additional), child.id],
    )
  }
  borrowed.length = 0
}

async function deleteCreated(): Promise<void> {
  if (createdContacts.length > 0) {
    await connection.query(
      `DELETE FROM family_members WHERE family_contact_id IN (${createdContacts.map(() => '?').join(', ')})`,
      createdContacts,
    )
    await connection.query(
      `DELETE FROM family_contacts WHERE id IN (${createdContacts.map(() => '?').join(', ')})`,
      createdContacts,
    )
  }
  if (createdFamilies.length > 0) {
    await connection.query(
      `DELETE FROM family_members WHERE family_id IN (${createdFamilies.map(() => '?').join(', ')})`,
      createdFamilies,
    )
    await connection.query(
      `DELETE FROM families WHERE id IN (${createdFamilies.map(() => '?').join(', ')})`,
      createdFamilies,
    )
  }
}

function selectList(columns: readonly string[]): string {
  return columns
    .map((column) =>
      BIT_COLUMNS.has(column)
        ? `${quoteIdentifier(column)} + 0 AS ${quoteIdentifier(column)}`
        : quoteIdentifier(column),
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
