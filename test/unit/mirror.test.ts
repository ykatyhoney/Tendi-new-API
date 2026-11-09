import { describe, expect, it } from 'vitest'
import { ApiError } from '../../src/lib/api-error.js'
import { assertLegacyLengths, deriveLegacyValues } from '../../src/modules/family/services/mirror/derive.js'
import type {
  MirrorContact,
  MirrorFamily,
  MirrorMember,
  MirrorPhone,
  ParentSlot,
} from '../../src/modules/family/services/mirror/types.js'

const child = { id: 1 }

describe('deriveLegacyValues', () => {
  it('fills the father slot and leaves the mother empty', () => {
    const values = deriveLegacyValues(child, family([father({ legacyFullName: 'Yaakov', fname: 'Yaakov', lname: 'Strauss' })]))
    expect(values.father_name).toBe('Yaakov')
    expect(values.father_fname).toBe('Yaakov')
    expect(values.father_lname).toBe('Strauss')
    expect(values.mother_name).toBe('')
    expect(values.mother_fname).toBe('')
    expect(values.mother_home_phone).toBe('')
    expect(values.mother_occupation).toBeNull()
    expect(values.mother_employer).toBeNull()
    expect(values.mother_office_phone).toBeNull()
    expect(values.use_mother_phone_for_notification).toBe(0)
    expect(values.notification_mother_phone_method).toBe('voice')
  })

  it('fills the mother slot and leaves the father empty', () => {
    const values = deriveLegacyValues(
      child,
      family([mother({ legacyFullName: 'Chaya', fname: 'Chaya', lname: 'Strauss', occupation: 'teacher' })]),
    )
    expect(values.mother_name).toBe('Chaya')
    expect(values.mother_fname).toBe('Chaya')
    expect(values.mother_occupation).toBe('teacher')
    expect(values.father_name).toBe('')
    expect(values.father_occupation).toBe('')
    expect(values.father_employer).toBeNull()
    expect(values.father_work_address).toBeNull()
    expect(values.use_father_phone_for_notification).toBe(0)
    expect(values.notification_father_phone_method).toBe('voice')
  })

  it('lets a step-parent fill an empty slot, and the real parent win when both exist', () => {
    const step = father({
      id: 2,
      slotRank: 2,
      sortOrder: 0,
      legacyFullName: 'Step',
    })
    const onlyStep = deriveLegacyValues(child, family([step]))
    expect(onlyStep.father_name).toBe('Step')

    const real = father({ id: 9, slotRank: 1, sortOrder: 5, legacyFullName: 'Father' })
    const both = deriveLegacyValues(child, family([step, real]))
    expect(both.father_name).toBe('Father')
  })

  it('keeps both parents and uses each parent for that slot', () => {
    const values = deriveLegacyValues(
      child,
      family([
        father({
          legacyFullName: 'Yaakov',
          phones: [mobile('2125550102', { isPrimary: true })],
          emails: [{ id: 1, email: 'dad@example.invalid', isPrimary: true, sortOrder: 0 }],
          occupation: 'office',
          employer: '',
        }),
        mother({
          legacyFullName: 'Chaya',
          phones: [home('(212) 555-0197', { isPrimary: true })],
          emails: [{ id: 2, email: 'mom@example.invalid', isPrimary: true, sortOrder: 0 }],
        }),
      ]),
    )
    expect(values.father_name).toBe('Yaakov')
    expect(values.father_phone).toBe('2125550102')
    expect(values.father_email).toBe('dad@example.invalid')
    expect(values.father_occupation).toBe('office')
    expect(values.father_employer).toBeNull()
    expect(values.mother_name).toBe('Chaya')
    expect(values.mother_phone).toBe('')
    expect(values.mother_home_phone).toBe('(212) 555-0197')
    expect(values.mother_email).toBe('mom@example.invalid')
  })

  it('uses the payment-responsible member, and the earlier one when two are marked', () => {
    const early = father({
      id: 1,
      sortOrder: 0,
      payment: true,
      emails: [{ id: 1, email: 'early@example.invalid', isPrimary: true, sortOrder: 0 }],
    })
    const late = mother({
      id: 2,
      sortOrder: 2,
      payment: true,
      emails: [{ id: 2, email: 'late@example.invalid', isPrimary: true, sortOrder: 0 }],
    })
    expect(deriveLegacyValues(child, family([late, early])).parent_email).toBe('early@example.invalid')

    const main = father({
      id: 3,
      isPrimary: true,
      emails: [{ id: 3, email: 'main@example.invalid', isPrimary: true, sortOrder: 0 }],
    })
    const other = mother({ id: 4, payment: false })
    expect(deriveLegacyValues(child, family([other, main])).parent_email).toBe('main@example.invalid')
  })

  it('F17 falls back to the main contact when the payer has no primary email', () => {
    const payer = mother({ id: 2, payment: true, isPrimary: false, emails: [] })
    const main = father({
      id: 1,
      isPrimary: true,
      emails: [{ id: 1, email: 'main17@example.invalid', isPrimary: true, sortOrder: 0 }],
    })
    expect(deriveLegacyValues(child, family([payer, main])).parent_email).toBe('main17@example.invalid')
    const payerWithEmail = mother({
      id: 2,
      payment: true,
      isPrimary: false,
      emails: [{ id: 2, email: 'payer17@example.invalid', isPrimary: true, sortOrder: 0 }],
    })
    expect(deriveLegacyValues(child, family([payerWithEmail, main])).parent_email).toBe('payer17@example.invalid')
  })

  it('uses the household of the family being derived when a contact is in two households', () => {
    const shared = father({
      phones: [mobile('2125550102', { isPrimary: true })],
    })
    const first = deriveLegacyValues(child, family([shared], '111-1111'))
    const second = deriveLegacyValues(child, family([{ ...shared, id: shared.id }], '222-2222'))
    expect(first.father_phone).toBe('2125550102')
    expect(second.father_phone).toBe('2125550102')
    expect(first.home_phone).toBe('111-1111')
    expect(second.home_phone).toBe('222-2222')
    expect(first.father_home_phone).toBe('111-1111')
    expect(second.father_home_phone).toBe('222-2222')
  })

  it('does not use a home, work, or other phone as the mobile', () => {
    const values = deriveLegacyValues(
      child,
      family([
        father({
          phones: [
            home('(212) 555-0100'),
            work('(212) 555-0101'),
            other("Grandma's cell", '(917) 555-0102'),
          ],
        }),
      ]),
    )
    expect(values.father_phone).toBe('')
    expect(values.father_home_phone).toBe('(212) 555-0100')
    expect(values.father_office_phone).toBe('(212) 555-0101')
    expect(JSON.stringify(values)).not.toContain("Grandma's cell")
    expect(JSON.stringify(values)).not.toContain('917')
  })

  it('uses the primary phone when it is a mobile, otherwise the first mobile', () => {
    const primary = deriveLegacyValues(
      child,
      family([
        father({
          phones: [
            mobile('111', { id: 1, sortOrder: 0 }),
            mobile('222', { id: 2, sortOrder: 5, isPrimary: true }),
          ],
        }),
      ]),
    )
    expect(primary.father_phone).toBe('222')

    const first = deriveLegacyValues(
      child,
      family([
        father({
          phones: [
            home('home', { isPrimary: true, id: 1 }),
            mobile('later', { id: 3, sortOrder: 2 }),
            mobile('earlier', { id: 2, sortOrder: 1 }),
          ],
        }),
      ]),
    )
    expect(first.father_phone).toBe('earlier')
  })

  it('joins a home address and leaves empty parts out', () => {
    const values = deriveLegacyValues(
      child,
      family([
        father({
          addresses: [
            {
              id: 1,
              type: 'home',
              isPrimary: true,
              line1: '10 Hekel Road',
              line2: '',
              city: 'Brooklyn',
              state: 'NY',
              zip: '11201',
            },
          ],
        }),
      ]),
    )
    expect(values.father_address).toBe('10 Hekel Road, Brooklyn, NY 11201')
  })

  it('refuses a value longer than the old column', () => {
    const values = deriveLegacyValues(
      child,
      family([father({ fname: 'x'.repeat(101) })]),
    )
    const lengths = new Map<string, number>([['father_fname', 100]])
    expect(() => assertLegacyLengths(values, lengths)).toThrow(ApiError)
    try {
      assertLegacyLengths(values, lengths)
    } catch (error) {
      expect(error).toMatchObject({
        statusCode: 409,
        code: 'VALUE_TOO_LONG',
        details: { column: 'father_fname' },
      })
    }
    expect(() => assertLegacyLengths(deriveLegacyValues(child, family([father({ fname: 'x'.repeat(100) })])), lengths)).not.toThrow()
  })
})

function family(members: MirrorMember[], householdPhone = ''): MirrorFamily {
  return { id: 10, householdPhone, members }
}

function father(overrides: MemberOverrides = {}): MirrorMember {
  return member('father', overrides)
}

function mother(overrides: MemberOverrides = {}): MirrorMember {
  return member('mother', overrides)
}

interface MemberOverrides {
  id?: number
  slotRank?: number
  sortOrder?: number
  isPrimary?: boolean
  payment?: boolean
  notify?: boolean
  method?: 'sms' | 'voice' | 'both'
  fname?: string
  lname?: string
  legacyFullName?: string
  occupation?: string
  employer?: string
  phones?: MirrorPhone[]
  emails?: MirrorContact['emails']
  addresses?: MirrorContact['addresses']
}

function member(slot: ParentSlot, overrides: MemberOverrides): MirrorMember {
  return {
    id: overrides.id ?? (slot === 'father' ? 1 : 2),
    contactId: overrides.id ?? (slot === 'father' ? 1 : 2),
    status: 'active',
    slot,
    slotRank: overrides.slotRank ?? 1,
    sortOrder: overrides.sortOrder ?? 0,
    isPrimary: overrides.isPrimary ?? slot === 'father',
    contact: {
      fname: overrides.fname ?? '',
      lname: overrides.lname ?? '',
      legacyFullName: overrides.legacyFullName ?? '',
      occupation: overrides.occupation ?? '',
      employer: overrides.employer ?? '',
      phones: overrides.phones ?? [],
      emails: overrides.emails ?? [],
      addresses: overrides.addresses ?? [],
    },
    rights: {
      receivesNotifications: overrides.notify ?? false,
      notifyMethod: overrides.method ?? 'voice',
      isPaymentResponsible: overrides.payment ?? false,
    },
  }
}

function mobile(phone: string, extra: Partial<MirrorPhone> = {}): MirrorPhone {
  return { id: extra.id ?? 1, phone, type: 'mobile', typeLabel: null, isPrimary: extra.isPrimary ?? false, sortOrder: extra.sortOrder ?? 0 }
}

function home(phone: string, extra: Partial<MirrorPhone> = {}): MirrorPhone {
  return { id: extra.id ?? 2, phone, type: 'home', typeLabel: null, isPrimary: extra.isPrimary ?? false, sortOrder: extra.sortOrder ?? 0 }
}

function work(phone: string, extra: Partial<MirrorPhone> = {}): MirrorPhone {
  return { id: extra.id ?? 3, phone, type: 'work', typeLabel: null, isPrimary: extra.isPrimary ?? false, sortOrder: extra.sortOrder ?? 0 }
}

function other(label: string, phone: string): MirrorPhone {
  return { id: 4, phone, type: 'other', typeLabel: label, isPrimary: false, sortOrder: 0 }
}
