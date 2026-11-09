import { describe, expect, it } from 'vitest'
import { phoneSearch } from '../../src/lib/phone.js'

describe('logic fixes: phone search', () => {
  it('F12 uses the last 10 digits exactly from 10 digits, a suffix from 7 to 9, and nothing below 7', () => {
    expect(phoneSearch('1 (718) 555-1212 ext. 9')).toEqual({ kind: 'exact', digits: '7185551212' })
    expect(phoneSearch('7185551212')).toEqual({ kind: 'exact', digits: '7185551212' })
    expect(phoneSearch('555-1212')).toEqual({ kind: 'suffix', digits: '5551212' })
    expect(phoneSearch('185551212')).toEqual({ kind: 'suffix', digits: '185551212' })
    expect(phoneSearch('123456')).toBeNull()
    expect(phoneSearch('Smith')).toBeNull()
  })
})
