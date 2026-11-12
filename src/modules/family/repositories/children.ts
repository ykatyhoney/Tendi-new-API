import type { RowDataPacket } from 'mysql2/promise'
import { likeContains } from '../../../lib/like.js'
import type { NotifyMethod } from '../schemas/common.js'
import { placeholders, rows, type Sql } from './query.js'

export interface ChildRow extends RowDataPacket {
  id: number
  familyId: number | null
  fname: string
  lname: string
  classId: number
  status: 'active' | 'inactive' | 'trash'
}

export interface RightsRow extends RowDataPacket {
  id: number
  memberId: number
  childId: number
  receivesNotifications: number
  notifyMethod: NotifyMethod
  mayCollect: number
  collectFrom: string | null
  collectTo: string | null
  isEmergency: number
  isPaymentResponsible: number
}

/**
 * The children linked to these families. A child trashed in the main admin keeps its family_id, so it is still
 * mirrored and still blocks archiving the family. The family list leaves it out; a family's own page asks for it
 * with includeTrashed (listed last), because that page is where it can be unlinked.
 */
export async function listChildren(
  db: Sql,
  familyIds: readonly number[],
  options: { includeTrashed?: boolean } = {},
): Promise<ChildRow[]> {
  if (familyIds.length === 0) {
    return []
  }
  return rows<ChildRow>(
    db,
    `SELECT id, family_id AS familyId, fname, lname, \`class\` AS classId, status
     FROM children
     WHERE family_id IN (${placeholders(familyIds.length)})
       ${options.includeTrashed === true ? '' : "AND status <> 'trash'"}
     ORDER BY family_id, status = 'trash', lname, fname, id`,
    familyIds,
  )
}

export async function findChild(db: Sql, childId: number): Promise<ChildRow | null> {
  const found = await rows<ChildRow>(
    db,
    `SELECT id, family_id AS familyId, fname, lname, \`class\` AS classId, status
     FROM children
     WHERE id = ?`,
    [childId],
  )
  return found[0] ?? null
}

/** Active family with the most rights rows for this child, then the lowest id. */
export async function draftFamilyId(db: Sql, childId: number): Promise<number | null> {
  const found = await rows<RowDataPacket>(
    db,
    `SELECT f.id AS familyId
     FROM family_member_children AS r
     INNER JOIN family_members AS m ON m.id = r.member_id AND m.status = 'active'
     INNER JOIN families AS f ON f.id = m.family_id AND f.status = 'active'
     WHERE r.child_id = ?
     GROUP BY f.id
     ORDER BY COUNT(*) DESC, f.id
     LIMIT 1`,
    [childId],
  )
  const id = found[0]?.['familyId']
  return id === undefined ? null : Number(id)
}

export interface ChildListRow extends RowDataPacket {
  id: number
  fname: string
  lname: string
  className: string | null
  status: 'active' | 'inactive'
  enrollmentStatus: string
  dob: string | null
  familyId: number | null
  familyName: string | null
}

export interface ChildListFilter {
  q: string
  status: 'active' | 'inactive' | 'all'
  linked: 'all' | 'yes' | 'no'
}

const CHILD_LIST_SELECT = `SELECT c.id, c.fname, c.lname,
         COALESCE(NULLIF(cl.friendly_name, ''), cl.name) AS className,
         c.status, c.enrollment_status AS enrollmentStatus, c.dob,
         c.family_id AS familyId, f.name AS familyName`

const CHILD_LIST_JOINS = `FROM children AS c
     LEFT JOIN classes AS cl ON cl.id = c.\`class\`
     LEFT JOIN families AS f ON f.id = c.family_id`

function childListWhere(filter: ChildListFilter): { sql: string; params: unknown[] } {
  const clauses: string[] = [
    filter.status === 'all' ? `c.status IN ('active', 'inactive')` : `c.status = ?`,
  ]
  const params: unknown[] = filter.status === 'all' ? [] : [filter.status]
  if (filter.linked === 'yes') {
    clauses.push('c.family_id IS NOT NULL')
  } else if (filter.linked === 'no') {
    clauses.push('c.family_id IS NULL')
  }
  const q = filter.q.trim()
  if (q.length > 0) {
    const like = likeContains(q)
    const match = [
      `c.fname LIKE ? ESCAPE '\\\\'`,
      `c.lname LIKE ? ESCAPE '\\\\'`,
      `CONCAT(c.fname, ' ', c.lname) LIKE ? ESCAPE '\\\\'`,
    ]
    params.push(like, like, like)
    if (/^\d{1,10}$/.test(q)) {
      match.push('c.id = ?')
      params.push(Number(q))
    }
    clauses.push(`(${match.join(' OR ')})`)
  }
  return { sql: `WHERE ${clauses.join(' AND ')}`, params }
}

/** Active and inactive children for the screens, paged in SQL. Trashed children are never listed. */
export async function pageChildList(
  db: Sql,
  filter: ChildListFilter,
  page: number,
  pageSize: number,
): Promise<{ total: number; children: ChildListRow[] }> {
  const where = childListWhere(filter)
  const [totals, children] = await Promise.all([
    rows<RowDataPacket>(db, `SELECT COUNT(*) AS total ${CHILD_LIST_JOINS} ${where.sql}`, where.params),
    rows<ChildListRow>(
      db,
      `${CHILD_LIST_SELECT}
       ${CHILD_LIST_JOINS}
       ${where.sql}
       ORDER BY c.lname, c.fname, c.id
       LIMIT ? OFFSET ?`,
      [...where.params, pageSize, (page - 1) * pageSize],
    ),
  ])
  return { total: Number(totals[0]?.['total'] ?? 0), children }
}

/** One active or inactive child, or null when it is unknown or trashed. */
export async function findChildListRow(db: Sql, childId: number): Promise<ChildListRow | null> {
  const found = await rows<ChildListRow>(
    db,
    `${CHILD_LIST_SELECT}
     ${CHILD_LIST_JOINS}
     WHERE c.id = ? AND c.status IN ('active', 'inactive')`,
    [childId],
  )
  return found[0] ?? null
}

/**
 * These members' rights rows, for the screens. A trashed child's rows are left out: its rights cannot be saved
 * (PUT .../rights answers 404 for it), and a row for a child the screens cannot open would be offered as a
 * child to link. The mirror reads rights with its own query and still sees them.
 */
export async function listRights(db: Sql, memberIds: readonly number[]): Promise<RightsRow[]> {
  if (memberIds.length === 0) {
    return []
  }
  return rows<RightsRow>(
    db,
    `SELECT r.id, r.member_id AS memberId, r.child_id AS childId,
            r.receives_notifications AS receivesNotifications, r.notify_method AS notifyMethod,
            r.may_collect AS mayCollect, r.collect_from AS collectFrom, r.collect_to AS collectTo,
            r.is_emergency AS isEmergency, r.is_payment_responsible AS isPaymentResponsible
     FROM family_member_children AS r
     INNER JOIN children AS c ON c.id = r.child_id AND c.status <> 'trash'
     WHERE r.member_id IN (${placeholders(memberIds.length)})
     ORDER BY r.member_id, r.child_id`,
    memberIds,
  )
}
