import { describe, expect, it } from 'vitest'
import { likeContains } from '../../src/lib/like.js'
import { digitsOf, phoneSearchKey } from '../../src/lib/phone.js'

describe('phone search key', () => {
  it('keeps the last ten digits when the query has at least seven', () => {
    expect(phoneSearchKey('718-555-1212')).toBe('7185551212')
    expect(phoneSearchKey('1 (718) 555-1212 ext. 9')).toBe('7185551212')
    expect(phoneSearchKey('555-1212')).toBe('5551212')
    expect(digitsOf('7185551212x99')).toBe('7185551212')
  })

  it('does not treat a short or digit-free query as a phone', () => {
    expect(phoneSearchKey('123456')).toBeNull()
    expect(phoneSearchKey('Smith')).toBeNull()
  })
})

describe('like contains', () => {
  it('escapes wildcards', () => {
    expect(likeContains('100%_a')).toBe('%100\\%\\_a%')
  })
})
