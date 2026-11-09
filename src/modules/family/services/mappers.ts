import type { RightsRow } from '../repositories/children.js'
import type { AddressRow, EmailRow, PhoneRow } from '../repositories/contacts.js'
import type { AddressOutput, EmailOutput, PhoneOutput } from '../schemas/common.js'
import type { RightsOutput } from '../schemas/family.js'
import { asBoolean, asNullableString, asNumber, asString } from './values.js'

/** Row-to-response mapping shared by the family and contact reads. */

export function toPhone(row: PhoneRow): PhoneOutput {
  return {
    id: asNumber(row.id),
    phone: asString(row.phone),
    type: row.type,
    typeLabel: asNullableString(row.typeLabel),
    channel: row.channel,
    isPrimary: asBoolean(row.isPrimary),
    sortOrder: asNumber(row.sortOrder),
  }
}

export function toEmail(row: EmailRow): EmailOutput {
  return {
    id: asNumber(row.id),
    email: asString(row.email),
    type: row.type,
    typeLabel: asNullableString(row.typeLabel),
    isPrimary: asBoolean(row.isPrimary),
    sortOrder: asNumber(row.sortOrder),
  }
}

export function toAddress(row: AddressRow): AddressOutput {
  return {
    id: asNumber(row.id),
    type: row.type,
    typeLabel: asNullableString(row.typeLabel),
    line1: asString(row.line1),
    line2: asString(row.line2),
    city: asString(row.city),
    state: asString(row.state),
    zip: asString(row.zip),
    isPrimary: asBoolean(row.isPrimary),
  }
}

export function toRights(row: RightsRow): RightsOutput {
  return {
    id: asNumber(row.id),
    childId: asNumber(row.childId),
    receivesNotifications: asBoolean(row.receivesNotifications),
    notifyMethod: row.notifyMethod,
    mayCollect: asBoolean(row.mayCollect),
    collectFrom: asNullableString(row.collectFrom),
    collectTo: asNullableString(row.collectTo),
    isEmergency: asBoolean(row.isEmergency),
    isPaymentResponsible: asBoolean(row.isPaymentResponsible),
  }
}
