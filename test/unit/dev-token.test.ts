import { describe, expect, it } from 'vitest'
import { parseDevTokenArgs } from '../../scripts/dev-token.js'
import { tokenHash } from '../../src/lib/token-hash.js'

describe('dev token arguments', () => {
  it('reads --admin and --revoke, and rejects a missing or combined command', () => {
    expect(parseDevTokenArgs(['--admin', '511'])).toEqual({ action: 'issue', adminId: 511 })
    expect(parseDevTokenArgs(['--revoke', '12'])).toEqual({ action: 'revoke', adminId: 12 })
    expect(() => parseDevTokenArgs([])).toThrow(/--admin/)
    expect(() => parseDevTokenArgs(['--admin', '--revoke', '4'])).toThrow(/either/)
    expect(() => parseDevTokenArgs(['--admin', '0'])).toThrow(/positive integer/)
    expect(() => parseDevTokenArgs(['--revoke'])).toThrow(/positive integer/)
  })
})

describe('token hash', () => {
  it('matches the md5 hex form stored in admin_api_tokens', () => {
    expect(tokenHash('abc')).toBe('900150983cd24fb0d6963f7d28e17f72')
  })
})
