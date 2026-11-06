import type { Pool } from 'mysql2/promise'
import { draftFamilyId, findChild } from '../repositories/children.js'
import { findActiveFamily } from '../repositories/families.js'
import type { ChildFamily } from '../schemas/family.js'
import { getFamily } from './families.js'

export async function getChildFamily(db: Pool, childId: number): Promise<ChildFamily | null> {
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
