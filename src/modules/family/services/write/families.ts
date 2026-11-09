import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise'
import { ApiError } from '../../../../lib/api-error.js'
import { withStaffTransaction } from '../../../../lib/with-transaction.js'
import { rows } from '../../repositories/query.js'
import type {
  CreateFamilyBody,
  CreateMemberBody,
  FamilyWriteResult,
  PatchFamilyBody,
  PatchMemberBody,
} from '../../schemas/family.js'
import type { NewContact } from '../../schemas/common.js'
import { getFamily } from '../families.js'
import { affectedChildIdsForFamily } from '../mirror/affected.js'
import { writeMirror } from '../mirror/write.js'
import { auditValue, columnChanges, familyIdsForContact, insertId, lockFamilies, writeAudit } from './audit.js'
import {
  activeMembers,
  deleteMemberRights,
  ensureMainContact,
  parentSlotCount,
  refuseEmptyParents,
} from './household.js'
import { contactNames, newLegacyFullName, requireChange } from './rules.js'

interface FamilyRecord extends RowDataPacket {
  id: number
  name: string
  householdPhone: string
  status: 'active' | 'trash'
}

interface MemberRecord extends RowDataPacket {
  id: number
  contactId: number
  relationship: string
  isPrimary: number
  sortOrder: number
  status: 'active' | 'trash'
}

interface ContactRecord extends RowDataPacket {
  id: number
  status: 'active' | 'trash'
}

export async function createFamily(pool: Pool, staffId: number, body: CreateFamilyBody): Promise<FamilyWriteResult> {
  const householdPhone = body.householdPhone ?? ''
  return withStaffTransaction(pool, staffId, async (connection) => {
    const familyId = await insertId(
      connection,
      `INSERT INTO families (name, household_phone, status, created_at, updated_at, created_by, updated_by)
       VALUES (?, ?, 'active', UTC_TIMESTAMP(), UTC_TIMESTAMP(), ?, ?)`,
      [body.name, householdPhone, staffId, staffId],
    )
    await lockFamilies(connection, [familyId])
    await writeAudit(connection, staffId, [
      { table: 'families', id: familyId, action: 'insert', column: 'name', oldValue: null, newValue: body.name },
      {
        table: 'families',
        id: familyId,
        action: 'insert',
        column: 'household_phone',
        oldValue: null,
        newValue: householdPhone,
      },
      { table: 'families', id: familyId, action: 'insert', column: 'status', oldValue: null, newValue: 'active' },
    ])
    const affected = await writeMirror(connection, await affectedChildIdsForFamily(connection, familyId))
    return finishFamily(connection, familyId, affected)
  })
}

export async function patchFamily(
  pool: Pool,
  staffId: number,
  familyId: number,
  body: PatchFamilyBody,
): Promise<FamilyWriteResult> {
  requireChange(body.name !== undefined || body.householdPhone !== undefined || body.status !== undefined)
  return withStaffTransaction(pool, staffId, async (connection) => {
    await lockFamilies(connection, [familyId])
    const current = await loadFamily(connection, familyId)
    if (body.status === 'trash' && current.status !== 'trash') {
      await refuseLinkedChildren(connection, familyId)
    }
    const next = {
      name: body.name ?? current.name,
      household_phone: body.householdPhone ?? current.householdPhone,
      status: body.status ?? current.status,
    }
    const changes = columnChanges(
      'families',
      familyId,
      'update',
      {
        name: current.name,
        household_phone: current.householdPhone,
        status: current.status,
      },
      next,
    )
    if (changes.length > 0) {
      await connection.query(
        `UPDATE families
         SET name = ?, household_phone = ?, status = ?, updated_at = UTC_TIMESTAMP(), updated_by = ?
         WHERE id = ?`,
        [next.name, next.household_phone, next.status, staffId, familyId],
      )
      await writeAudit(connection, staffId, changes)
    }
    const affected = await writeMirror(connection, await affectedChildIdsForFamily(connection, familyId))
    return finishFamily(connection, familyId, affected)
  })
}

export async function createMember(
  pool: Pool,
  staffId: number,
  familyId: number,
  body: CreateMemberBody,
): Promise<FamilyWriteResult> {
  return withStaffTransaction(pool, staffId, async (connection) => {
    await lockFamilies(connection, [familyId])
    const family = await loadFamily(connection, familyId)
    if (family.status !== 'active') {
      throw new ApiError(404, 'NOT_FOUND', 'Family not found')
    }
    await requireActiveRelationship(connection, body.relationship)
    const contactId = 'contactId' in body
      ? await requireActiveContact(connection, body.contactId)
      : await insertContact(connection, staffId, body.contact)
    const memberId = await saveMembership(connection, staffId, familyId, contactId, body)
    if (body.isPrimary === true) {
      await clearOtherPrimaries(connection, staffId, familyId, memberId)
    }
    // The first active member of a household becomes its main contact.
    await ensureMainContact(connection, staffId, familyId)
    const affected = await writeMirror(connection, await affectedChildIdsForFamily(connection, familyId))
    return finishFamily(connection, familyId, affected)
  })
}

export async function patchMember(
  pool: Pool,
  staffId: number,
  familyId: number,
  memberId: number,
  body: PatchMemberBody,
): Promise<FamilyWriteResult> {
  requireChange(body.relationship !== undefined || body.isPrimary !== undefined || body.sortOrder !== undefined)
  return withStaffTransaction(pool, staffId, async (connection) => {
    await lockFamilies(connection, [familyId])
    const family = await loadFamily(connection, familyId)
    if (family.status !== 'active') {
      throw new ApiError(404, 'NOT_FOUND', 'Family not found')
    }
    const member = await loadActiveMember(connection, familyId, memberId)
    // Only a new relationship must be active: a member keeps a type that was deactivated after it was given.
    const relationshipChanges = body.relationship !== undefined && body.relationship !== member.relationship
    if (relationshipChanges && body.relationship !== undefined) {
      await requireActiveRelationship(connection, body.relationship)
    }
    const linked = relationshipChanges ? await affectedChildIdsForFamily(connection, familyId) : []
    const slotsBefore = relationshipChanges ? await parentSlotCount(connection, familyId) : 0
    const demotingMain = body.isPrimary === false && Number(member.isPrimary) === 1
    if (demotingMain && (await activeMembers(connection, familyId)).length <= 1) {
      throw new ApiError(409, 'MAIN_CONTACT_REQUIRED', 'A household with members needs a main contact.')
    }
    const next = {
      relationship: body.relationship ?? member.relationship,
      is_primary: auditValue(body.isPrimary === undefined ? member.isPrimary : body.isPrimary ? 1 : 0),
      sort_order: auditValue(body.sortOrder ?? member.sortOrder),
    }
    const changes = columnChanges(
      'family_members',
      memberId,
      'update',
      {
        relationship: member.relationship,
        is_primary: auditValue(member.isPrimary),
        sort_order: auditValue(member.sortOrder),
      },
      next,
    )
    if (body.isPrimary === true) {
      await clearOtherPrimaries(connection, staffId, familyId, memberId)
    }
    if (changes.length > 0) {
      await connection.query(
        `UPDATE family_members SET relationship = ?, is_primary = ?, sort_order = ? WHERE id = ?`,
        [next.relationship, Number(next.is_primary), Number(next.sort_order), memberId],
      )
      await writeAudit(connection, staffId, changes)
    }
    // Demoting the main contact promotes the next member, never this one again.
    await ensureMainContact(connection, staffId, familyId, demotingMain ? memberId : undefined)
    if (relationshipChanges) {
      await refuseEmptyParents(connection, familyId, linked, slotsBefore, body.allowEmptyParents === true)
    }
    const affected = await writeMirror(connection, await affectedChildIdsForFamily(connection, familyId))
    return finishFamily(connection, familyId, affected)
  })
}

export async function deleteMember(
  pool: Pool,
  staffId: number,
  familyId: number,
  memberId: number,
  options: { allowEmptyParents?: boolean } = {},
): Promise<FamilyWriteResult> {
  return withStaffTransaction(pool, staffId, async (connection) => {
    await lockFamilies(connection, [familyId])
    const family = await loadFamily(connection, familyId)
    if (family.status !== 'active') {
      throw new ApiError(404, 'NOT_FOUND', 'Family not found')
    }
    const member = await loadActiveMember(connection, familyId, memberId)
    const linked = await affectedChildIdsForFamily(connection, familyId)
    const before = await activeMembers(connection, familyId)
    // Link needs an active member, so a family with linked children keeps one (the same 409 as trashing it).
    if (linked.length > 0 && before.every((row) => row.id === memberId)) {
      throw new ApiError(409, 'HAS_LINKED_CHILDREN', `Unlink this family's children before removing its last member.`, {
        childIds: linked,
      })
    }
    const slotsBefore = before.filter((row) => row.slot !== null).length
    await connection.query(`UPDATE family_members SET status = 'trash', is_primary = 0 WHERE id = ?`, [memberId])
    await writeAudit(connection, staffId, [
      {
        table: 'family_members',
        id: memberId,
        action: 'update',
        column: 'status',
        oldValue: 'active',
        newValue: 'trash',
      },
      ...(member.isPrimary
        ? [
            {
              table: 'family_members',
              id: memberId,
              action: 'update' as const,
              column: 'is_primary',
              oldValue: '1',
              newValue: '0',
            },
          ]
        : []),
    ])
    // A member who is added back later starts with no rights for the family's children.
    await deleteMemberRights(connection, staffId, memberId)
    if (Number(member.isPrimary) === 1) {
      await ensureMainContact(connection, staffId, familyId)
    }
    await refuseEmptyParents(connection, familyId, linked, slotsBefore, options.allowEmptyParents === true)
    const affected = await writeMirror(connection, await affectedChildIdsForFamily(connection, familyId))
    return finishFamily(connection, familyId, affected)
  })
}

/** Read inside the save's transaction, so the response is what this save committed, or nothing is committed. */
async function finishFamily(connection: PoolConnection, familyId: number, affected: number[]): Promise<FamilyWriteResult> {
  const family = await getFamily(connection, familyId, true)
  if (family === null) {
    throw new ApiError(500, 'INTERNAL', 'Family could not be read after it was saved.')
  }
  return { family, affected_child_ids: affected }
}

async function loadFamily(connection: PoolConnection, familyId: number): Promise<FamilyRecord> {
  const found = await rows<FamilyRecord>(
    connection,
    `SELECT id, name, household_phone AS householdPhone, status FROM families WHERE id = ?`,
    [familyId],
  )
  const family = found[0]
  if (family === undefined) {
    throw new ApiError(404, 'NOT_FOUND', 'Family not found')
  }
  return family
}

async function loadActiveMember(
  connection: PoolConnection,
  familyId: number,
  memberId: number,
): Promise<MemberRecord> {
  const found = await rows<MemberRecord>(
    connection,
    `SELECT id, family_contact_id AS contactId, relationship, is_primary AS isPrimary, sort_order AS sortOrder, status
     FROM family_members
     WHERE id = ? AND family_id = ?
     FOR UPDATE`,
    [memberId, familyId],
  )
  const member = found[0]
  if (member === undefined || member.status !== 'active') {
    throw new ApiError(404, 'NOT_FOUND', 'Member not found')
  }
  return member
}

/**
 * A share lock on the type row: a deactivation (FOR UPDATE in relationship-types.ts) waits for this save to
 * commit, or this save waits for the deactivation and then sees it. Either way no new member gets an inactive type.
 */
async function requireActiveRelationship(connection: PoolConnection, code: string): Promise<void> {
  const found = await rows<RowDataPacket>(
    connection,
    `SELECT code, status FROM relationship_types WHERE code = ? LOCK IN SHARE MODE`,
    [code],
  )
  if (found[0]?.['status'] !== 'active') {
    throw new ApiError(400, 'UNKNOWN_RELATIONSHIP', 'That relationship is not an active relationship type.')
  }
}

async function requireActiveContact(connection: PoolConnection, contactId: number): Promise<number> {
  await lockContact(connection, contactId)
  const found = await rows<ContactRecord>(
    connection,
    `SELECT id, status FROM family_contacts WHERE id = ?`,
    [contactId],
  )
  const contact = found[0]
  if (contact === undefined || contact.status !== 'active') {
    throw new ApiError(404, 'NOT_FOUND', 'Contact not found')
  }
  return contactId
}

async function lockContact(connection: PoolConnection, contactId: number): Promise<void> {
  await rows<RowDataPacket>(connection, `SELECT id FROM family_contacts WHERE id = ? FOR UPDATE`, [contactId])
}

async function insertContact(
  connection: PoolConnection,
  staffId: number,
  contact: NewContact,
): Promise<number> {
  const { fname, lname } = contactNames(contact.fname, contact.lname)
  const hebrewName = contact.hebrewName ?? ''
  const occupation = contact.occupation ?? ''
  const employer = contact.employer ?? ''
  const note = contact.note ?? null
  // The legacy format: the first name only, as the legacy app keeps father_name and mother_name.
  const legacy = newLegacyFullName(fname, lname)
  const contactId = await insertId(
    connection,
    `INSERT INTO family_contacts
       (fname, lname, legacy_full_name, hebrew_name, occupation, employer, note, status, created_at, updated_at, created_by, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', UTC_TIMESTAMP(), UTC_TIMESTAMP(), ?, ?)`,
    [fname, lname, legacy, hebrewName, occupation, employer, note, staffId, staffId],
  )
  await lockContact(connection, contactId)
  await writeAudit(
    connection,
    staffId,
    columnChanges(
      'family_contacts',
      contactId,
      'insert',
      {},
      {
        fname,
        lname,
        legacy_full_name: legacy,
        hebrew_name: hebrewName,
        occupation,
        employer,
        note,
        status: 'active',
      },
    ),
  )
  return contactId
}

async function saveMembership(
  connection: PoolConnection,
  staffId: number,
  familyId: number,
  contactId: number,
  body: CreateMemberBody,
): Promise<number> {
  const existing = await rows<MemberRecord>(
    connection,
    `SELECT id, family_contact_id AS contactId, relationship, is_primary AS isPrimary, sort_order AS sortOrder, status
     FROM family_members
     WHERE family_id = ? AND family_contact_id = ?
     FOR UPDATE`,
    [familyId, contactId],
  )
  const isPrimary = body.isPrimary === true ? 1 : 0
  const sortOrder = body.sortOrder ?? 0
  const current = existing[0]
  if (current !== undefined && current.status === 'active') {
    throw new ApiError(409, 'ALREADY_MEMBER', 'That contact is already in this family.')
  }
  if (current !== undefined) {
    await connection.query(
      `UPDATE family_members SET relationship = ?, is_primary = ?, sort_order = ?, status = 'active' WHERE id = ?`,
      [body.relationship, isPrimary, sortOrder, current.id],
    )
    await writeAudit(
      connection,
      staffId,
      columnChanges(
        'family_members',
        current.id,
        'update',
        {
          relationship: current.relationship,
          is_primary: auditValue(current.isPrimary),
          sort_order: auditValue(current.sortOrder),
          status: current.status,
        },
        {
          relationship: body.relationship,
          is_primary: auditValue(isPrimary),
          sort_order: auditValue(sortOrder),
          status: 'active',
        },
      ),
    )
    return current.id
  }
  const memberId = await insertId(
    connection,
    `INSERT INTO family_members (family_id, family_contact_id, relationship, is_primary, sort_order, status)
     VALUES (?, ?, ?, ?, ?, 'active')`,
    [familyId, contactId, body.relationship, isPrimary, sortOrder],
  )
  await writeAudit(
    connection,
    staffId,
    columnChanges(
      'family_members',
      memberId,
      'insert',
      {},
      {
        family_id: auditValue(familyId),
        family_contact_id: auditValue(contactId),
        relationship: body.relationship,
        is_primary: auditValue(isPrimary),
        sort_order: auditValue(sortOrder),
        status: 'active',
      },
    ),
  )
  return memberId
}

async function clearOtherPrimaries(
  connection: PoolConnection,
  staffId: number,
  familyId: number,
  keepMemberId: number,
): Promise<void> {
  const others = await rows<RowDataPacket>(
    connection,
    `SELECT id FROM family_members
     WHERE family_id = ? AND status = 'active' AND is_primary = 1 AND id <> ?
     ORDER BY id
     FOR UPDATE`,
    [familyId, keepMemberId],
  )
  if (others.length === 0) {
    return
  }
  await connection.query(
    `UPDATE family_members SET is_primary = 0
     WHERE family_id = ? AND status = 'active' AND is_primary = 1 AND id <> ?`,
    [familyId, keepMemberId],
  )
  await writeAudit(
    connection,
    staffId,
    others.map((row) => ({
      table: 'family_members',
      id: Number(row['id']),
      action: 'update' as const,
      column: 'is_primary',
      oldValue: '1',
      newValue: '0',
    })),
  )
}

/**
 * Locks every household this contact belongs to, then the contact.
 * The membership list is read again after each lock, because a household can gain this contact while
 * the save waits. Adding a member locks the contact, so once the contact is locked the list is final.
 */
export async function lockContactFamilies(connection: PoolConnection, contactId: number): Promise<void> {
  const locked = new Set<number>()
  let contactLocked = false
  for (;;) {
    const fresh = (await familyIdsForContact(connection, contactId)).filter((id) => !locked.has(id))
    if (fresh.length === 0 && contactLocked) {
      return
    }
    await lockFamilies(connection, fresh)
    for (const id of fresh) {
      locked.add(id)
    }
    if (!contactLocked) {
      await lockContact(connection, contactId)
      contactLocked = true
    }
  }
}

/** A household with linked children keeps mirroring them, so it cannot be trashed until they are unlinked. */
async function refuseLinkedChildren(connection: PoolConnection, familyId: number): Promise<void> {
  const linked = await affectedChildIdsForFamily(connection, familyId)
  if (linked.length > 0) {
    throw new ApiError(409, 'HAS_LINKED_CHILDREN', `Unlink this family's children before trashing it.`, {
      childIds: linked,
    })
  }
}
