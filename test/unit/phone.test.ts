import { describe, expect, it } from 'vitest'
import { likeContains } from '../../src/lib/like.js'
import { digitsOf, phoneSearch } from '../../src/lib/phone.js'

describe('phone search key', () => {
  it('keeps the last ten digits for an exact match, and seven to nine digits as a suffix', () => {
    expect(phoneSearch('718-555-1212')).toEqual({ kind: 'exact', digits: '7185551212' })
    expect(phoneSearch('1 (718) 555-1212 ext. 9')).toEqual({ kind: 'exact', digits: '7185551212' })
    expect(phoneSearch('555-1212')).toEqual({ kind: 'suffix', digits: '5551212' })
    expect(digitsOf('7185551212x99')).toBe('7185551212')
  })

  it('does not treat a short or digit-free query as a phone', () => {
    expect(phoneSearch('123456')).toBeNull()
    expect(phoneSearch('Smith')).toBeNull()
  })
})

describe('like contains', () => {
  it('escapes wildcards', () => {
    expect(likeContains('100%_a')).toBe('%100\\%\\_a%')
  })
})
