import type { Sql } from '../repositories/query.js'
import {
  draftFamilyId,
  findChild,
  findChildListRow,
  pageChildList,
  type ChildListRow,
} from '../repositories/children.js'
import { findActiveFamily } from '../repositories/families.js'
import type { ChildListItem, ChildListQuery, ChildPage } from '../schemas/child.js'
import type { ChildFamily } from '../schemas/family.js'
import { getFamily } from './families.js'
import { asNumber, asString } from './values.js'

export async function getChildFamily(db: Sql, childId: number): Promise<ChildFamily | null> {
  const child = await findChild(db, childId)
  if (child === null) {
    return null
  }
  if (child.familyId !== null) {
    const linked = await findActiveFamily(db, Number(child.familyId))
    if (linked !== null) {
      const family = await getFamily(db, linked.id)
      if (family !== null) {
        return { link: 'linked', family }
      }
    }
  }
  const draftId = await draftFamilyId(db, childId)
  if (draftId === null) {
    return null
  }
  const family = await getFamily(db, draftId)
  if (family === null) {
    return null
  }
  return { link: 'draft', family }
}

export async function searchChildren(db: Sql, query: ChildListQuery): Promise<ChildPage> {
  const page = await pageChildList(
    db,
    { q: query.q ?? '', status: query.status, linked: query.linked },
    query.page,
    query.pageSize,
  )
  return {
    items: page.children.map(toChildListItem),
    page: query.page,
    pageSize: query.pageSize,
    total: page.total,
  }
}

export async function getChild(db: Sql, childId: number): Promise<ChildListItem | null> {
  const row = await findChildListRow(db, childId)
  return row === null ? null : toChildListItem(row)
}

/** The legacy table holds 0000-00-00 dates; dateStrings keeps them as text. */
function dateOrNull(value: unknown): string | null {
  const text = asString(value)
  return /^\d{4}-\d{2}-\d{2}$/.test(text) && text !== '0000-00-00' ? text : null
}

function toChildListItem(row: ChildListRow): ChildListItem {
  return {
    id: asNumber(row.id),
    fname: asString(row.fname),
    lname: asString(row.lname),
    className: asString(row.className),
    status: row.status,
    enrollmentStatus: asString(row.enrollmentStatus),
    dob: dateOrNull(row.dob),
    familyId: row.familyId === null ? null : asNumber(row.familyId),
    familyName: row.familyName === null ? null : asString(row.familyName),
  }
}
