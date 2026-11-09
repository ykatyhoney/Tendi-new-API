import { describe, expect, it } from 'vitest'
import { planList } from '../../src/modules/family/services/write/contacts.js'

const spec = { noun: 'phone', columns: ['phone', 'type', 'is_primary'] }
const stored = new Map([
  [10, { phone: '111', type: 'mobile', is_primary: 1 }],
  [11, { phone: '222', type: 'work', is_primary: 0 }],
])

describe('planList', () => {
  it('keeps identical rows without ids and changes nothing', () => {
    const plan = planList(spec, stored, [
      { id: undefined, values: { phone: '222', type: 'work', is_primary: 0 } },
      { id: undefined, values: { phone: '111', type: 'mobile', is_primary: 1 } },
    ])
    expect(plan).toEqual({ deletes: [], updates: [], inserts: [] })
  })

  it('updates rows named by id, inserts new rows, and deletes unclaimed rows', () => {
    const plan = planList(spec, stored, [
      { id: 10, values: { phone: '111', type: 'mobile', is_primary: 0 } },
      { id: undefined, values: { phone: '333', type: 'home', is_primary: 1 } },
    ])
    expect(plan.updates).toEqual([{ id: 10, values: { phone: '111', type: 'mobile', is_primary: 0 } }])
    expect(plan.inserts).toEqual([{ phone: '333', type: 'home', is_primary: 1 }])
    expect(plan.deletes).toEqual([11])
  })

  it('refuses an id that is not one of this contact\'s rows, or one listed twice', () => {
    expect(() => planList(spec, stored, [{ id: 99, values: {} }])).toThrow(/Unknown phone id 99/)
    expect(() =>
      planList(spec, stored, [
        { id: 10, values: {} },
        { id: 10, values: {} },
      ]),
    ).toThrow(/listed twice/)
  })

  it('compares numbers and their text the same way', () => {
    const plan = planList(spec, new Map([[5, { phone: '111', type: 'mobile', is_primary: '1' }]]), [
      { id: undefined, values: { phone: '111', type: 'mobile', is_primary: 1 } },
    ])
    expect(plan).toEqual({ deletes: [], updates: [], inserts: [] })
  })
})
