// Phones as stored: the phone as typed plus phone_normalized, computed here (never accepted from
// the client) with the shared normalizer, src/lib/phone.ts.

import { normalizePhone } from '../../../lib/phone.ts';

export interface PhoneRow {
  phone: string;
  phone_normalized: string;
  label: string;
  channel: string;
  is_primary: boolean;
  sort_order: number;
}

export function preparePhones(
  phones: { phone: string; label: string; channel: string; is_primary: boolean; sort_order?: number }[],
): PhoneRow[] {
  return phones.map((p, i) => ({
    phone: p.phone,
    phone_normalized: normalizePhone(p.phone),
    label: p.label,
    channel: p.channel,
    is_primary: p.is_primary,
    sort_order: p.sort_order ?? i,
  }));
}
