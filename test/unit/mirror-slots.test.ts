import { describe, expect, it } from 'vitest'
import { mirrorSlots, pickParent, type SlotCandidate } from '../../src/modules/family/services/mirror/derive.js'

function member(id: number, slot: SlotCandidate['slot'], slotRank: number | null, sortOrder = 0, status: SlotCandidate['status'] = 'active'): SlotCandidate {
  return { id, status, slot, slotRank, sortOrder }
}

describe('mirrorSlots', () => {
  it('picks the real parent before the step-parent, then sort order, then member id', () => {
    const members = [
      member(1, 'father', 2, 0), // step_father
      member(2, 'father', 1, 5), // father, later in the list
      member(3, 'mother', 1, 2),
      member(4, 'mother', 1, 1),
      member(5, null, null),
    ]
    expect(mirrorSlots(members)).toEqual(new Map([[2, 'father'], [4, 'mother']]))
    expect(pickParent([member(9, 'mother', 1, 0), member(8, 'mother', 1, 0)], 'mother')?.id).toBe(8)
  })

  it('lets a step-parent fill an empty slot and ignores trashed members', () => {
    const members = [member(1, 'father', 1, 0, 'trash'), member(2, 'father', 2, 0)]
    expect(mirrorSlots(members)).toEqual(new Map([[2, 'father']]))
  })

  it('leaves both slots empty when no member has one', () => {
    expect(mirrorSlots([member(1, null, null)]).size).toBe(0)
  })
})
