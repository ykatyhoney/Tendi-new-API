export type ParentSlot = 'father' | 'mother'
export type PhoneType = 'mobile' | 'home' | 'work' | 'other'
export type AddressType = 'home' | 'work' | 'billing' | 'other'
export type NotifyMethod = 'sms' | 'voice' | 'both'

export interface MirrorPhone {
  id: number
  phone: string
  type: PhoneType
  typeLabel: string | null
  isPrimary: boolean
  sortOrder: number
}

export interface MirrorEmail {
  id: number
  email: string
  isPrimary: boolean
  sortOrder: number
}

export interface MirrorAddress {
  id: number
  type: AddressType
  line1: string
  line2: string
  city: string
  state: string
  zip: string
  isPrimary: boolean
}

export interface MirrorContact {
  fname: string
  lname: string
  legacyFullName: string
  occupation: string
  employer: string
  phones: MirrorPhone[]
  emails: MirrorEmail[]
  addresses: MirrorAddress[]
}

export interface MirrorRights {
  receivesNotifications: boolean
  notifyMethod: NotifyMethod
  isPaymentResponsible: boolean
}

export interface MirrorMember {
  id: number
  contactId: number
  status: 'active' | 'trash'
  slot: ParentSlot | null
  slotRank: number | null
  sortOrder: number
  isPrimary: boolean
  contact: MirrorContact
  /** Rights for the child being derived. Null when this child has no rights row. */
  rights: MirrorRights | null
}

export interface MirrorFamily {
  id: number
  householdPhone: string
  members: MirrorMember[]
}

export interface MirrorChild {
  id: number
}

export interface LegacyValues {
  father_name: string
  mother_name: string
  father_phone: string
  mother_phone: string
  home_phone: string
  parent_email: string
  use_father_phone_for_notification: 0 | 1
  use_mother_phone_for_notification: 0 | 1
  notification_father_phone_method: NotifyMethod
  notification_mother_phone_method: NotifyMethod
  father_fname: string
  father_lname: string
  father_email: string
  father_home_phone: string
  father_office_phone: string
  father_address: string
  father_occupation: string
  father_work_address: string | null
  father_employer: string | null
  mother_fname: string
  mother_lname: string
  mother_email: string
  mother_home_phone: string
  mother_address: string
  mother_office_phone: string | null
  mother_work_address: string | null
  mother_occupation: string | null
  mother_employer: string | null
}

export const CHILDREN_MIRROR_COLUMNS = [
  'father_name',
  'mother_name',
  'father_phone',
  'mother_phone',
  'home_phone',
  'parent_email',
  'use_father_phone_for_notification',
  'use_mother_phone_for_notification',
  'notification_father_phone_method',
  'notification_mother_phone_method',
] as const

export const ADDITIONAL_MIRROR_COLUMNS = [
  'father_fname',
  'father_lname',
  'father_email',
  'father_home_phone',
  'father_office_phone',
  'father_address',
  'father_occupation',
  'father_work_address',
  'father_employer',
  'mother_fname',
  'mother_lname',
  'mother_email',
  'mother_home_phone',
  'mother_address',
  'mother_office_phone',
  'mother_work_address',
  'mother_occupation',
  'mother_employer',
] as const

export type ChildrenMirrorColumn = (typeof CHILDREN_MIRROR_COLUMNS)[number]
export type AdditionalMirrorColumn = (typeof ADDITIONAL_MIRROR_COLUMNS)[number]
export type LegacyColumn = ChildrenMirrorColumn | AdditionalMirrorColumn
