// Pure planning step of the family backfill (PLAN.md "Data backfill and proof of equivalence"):
// turns legacy child rows into draft households, people, phones, addresses, members and rights,
// plus a review list. No database access here, so it can be unit-tested.

import { normalizePhone } from '../lib/phone.ts';

export type Slot = 'father' | 'mother';
export type NotifyMethod = 'sms' | 'voice' | 'both';

/** One non-trash, unlinked child: children columns plus its children_additional_information row. */
export interface LegacyChild {
  id: number;
  lname: string;
  father_name: string;
  mother_name: string;
  father_phone: string;
  mother_phone: string;
  home_phone: string;
  parent_email: string;
  use_father_phone_for_notification: number | null;
  use_mother_phone_for_notification: number | null;
  notification_father_phone_method: NotifyMethod | null;
  notification_mother_phone_method: NotifyMethod | null;
  has_cai: boolean;
  /** children_additional_information values by column name (NULL read as ''). */
  cai: Record<string, string>;
}

export const REVIEW_CODES = {
  SHARED_PHONE_DIFFERENT_SURNAME: 'Children share a parent phone but have different surnames; kept in separate households (D3)',
  PHONE_IN_MANY_HOUSEHOLDS: 'A parent phone appears in more than 2 draft households',
  SIBLING_EMAIL_CONFLICT: 'Siblings in one household have different emails (parent_email, or the same parent\'s email)',
  MERGED_SIBLINGS: 'Children merged into one household by shared phone and surname; confirm (D3: every merge is reviewed)',
  PARENT_DIFFERS_BETWEEN_SIBLINGS: 'A parent slot is filled by different people (or by nobody) across siblings; the mirror uses one person per slot',
  PERSON_DETAILS_DIFFER: 'The same parent (phone + name) has different details across siblings; the lowest child id was used',
  PAYMENT_EMAIL_UNMATCHED: 'parent_email matches neither parent\'s email; nobody is payment-responsible for this child',
  HOME_PHONE_CONFLICT: 'Siblings have different home_phone values; the most common one became household_phone',
  SHORT_PHONE: 'A phone has fewer than 10 digits; stored as typed with an empty phone_normalized and not used for grouping',
} as const;
export type ReviewCode = keyof typeof REVIEW_CODES;

export interface ReviewItem {
  code: ReviewCode;
  householdRefs: number[];
  childIds: number[];
  phone: string;
  detail: string;
}

export interface PlannedPhone { phone: string; normalized: string; label: 'mobile' | 'home' | 'work'; isPrimary: boolean; sortOrder: number }
export interface PlannedAddress { kind: 'home' | 'work'; line1: string }

export interface PlannedPerson {
  slot: Slot;
  fname: string;
  lname: string;
  legacyFullName: string;
  email: string;
  occupation: string;
  employer: string;
  phones: PlannedPhone[];
  addresses: PlannedAddress[];
  sortOrder: number;
  isPrimary: boolean;
}

export interface PlannedRights {
  childId: number;
  person: PlannedPerson;
  receivesNotifications: boolean;
  notifyMethod: NotifyMethod;
  isPaymentResponsible: boolean;
}

export interface PlannedHousehold {
  ref: number;
  name: string;
  householdPhone: string;
  childIds: number[];
  people: PlannedPerson[];
  rights: PlannedRights[];
}

export interface Plan {
  households: PlannedHousehold[];
  review: ReviewItem[];
}

export interface PlanOptions {
  /** Also group on children_additional_information.father_home_phone / mother_home_phone (not in D3). */
  groupByHomePhone?: boolean;
}

const clean = (s: string | null | undefined) => (s ?? '').trim();
const key = (s: string | null | undefined) => clean(s).toLowerCase().replace(/\s+/g, ' ');

interface SlotData {
  legacyName: string; fname: string; lname: string; phone: string; homePhone: string; officePhone: string;
  email: string; address: string; workAddress: string; occupation: string; employer: string;
}

function slotData(child: LegacyChild, slot: Slot): SlotData {
  const c = (field: string) => clean(child.cai[`${slot}_${field}`]);
  return {
    legacyName: child[`${slot}_name`] ?? '',
    fname: c('fname'),
    lname: c('lname'),
    phone: clean(child[`${slot}_phone`]),
    homePhone: c('home_phone'),
    officePhone: c('office_phone'),
    email: c('email'),
    address: c('address'),
    workAddress: c('work_address'),
    occupation: c('occupation'),
    employer: c('employer'),
  };
}

const hasData = (d: SlotData) => Object.values(d).some((v) => clean(v) !== '');

/** Identity of a parent within a household: normalized primary phone + name (D3 dedupe). */
const personKey = (d: SlotData) => `${normalizePhone(d.phone)}|${key(clean(d.legacyName) || `${d.fname} ${d.lname}`)}`;

/** Most common non-empty value, ties to the earliest; '' when none. */
function mostCommon(values: string[]): string {
  const counts = new Map<string, number>();
  for (const v of values) if (v !== '') counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = '';
  let bestCount = 0;
  for (const [v, n] of counts) if (n > bestCount) { best = v; bestCount = n; }
  return best;
}

class UnionFind {
  private parent = new Map<number, number>();
  find(x: number): number {
    const p = this.parent.get(x) ?? x;
    if (p === x) return x;
    const root = this.find(p);
    this.parent.set(x, root);
    return root;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(Math.max(ra, rb), Math.min(ra, rb));
  }
}

function newPerson(slot: Slot, d: SlotData): PlannedPerson {
  const phones: PlannedPhone[] = [];
  if (d.phone) phones.push({ phone: d.phone, normalized: normalizePhone(d.phone), label: 'mobile', isPrimary: true, sortOrder: 0 });
  if (d.homePhone) phones.push({ phone: d.homePhone, normalized: normalizePhone(d.homePhone), label: 'home', isPrimary: false, sortOrder: 1 });
  if (d.officePhone) phones.push({ phone: d.officePhone, normalized: normalizePhone(d.officePhone), label: 'work', isPrimary: false, sortOrder: 2 });
  const addresses: PlannedAddress[] = [];
  if (d.address) addresses.push({ kind: 'home', line1: d.address });
  if (d.workAddress) addresses.push({ kind: 'work', line1: d.workAddress });
  return {
    slot, fname: d.fname, lname: d.lname, legacyFullName: d.legacyName, email: d.email,
    occupation: d.occupation, employer: d.employer, phones, addresses, sortOrder: 0, isPrimary: false,
  };
}

export function planBackfill(input: LegacyChild[], options: PlanOptions = {}): Plan {
  const children = [...input].sort((a, b) => a.id - b.id);
  const review: ReviewItem[] = [];
  const flag = (code: ReviewCode, item: Omit<ReviewItem, 'code' | 'householdRefs' | 'phone'> & Partial<ReviewItem>) =>
    review.push({ code, householdRefs: [], phone: '', ...item });

  // 1. Grouping keys: normalized parent phones (D3), optionally the home phones too.
  const groupingPhones = new Map<number, Set<string>>();
  const byPhone = new Map<string, LegacyChild[]>();
  for (const child of children) {
    const raw: [string, string][] = [['father_phone', child.father_phone], ['mother_phone', child.mother_phone]];
    if (options.groupByHomePhone) {
      raw.push(['father_home_phone', child.cai.father_home_phone ?? ''], ['mother_home_phone', child.cai.mother_home_phone ?? '']);
    }
    const phones = new Set<string>();
    for (const [, value] of raw) {
      const n = normalizePhone(value);
      if (n) phones.add(n);
    }
    groupingPhones.set(child.id, phones);
    for (const n of phones) byPhone.set(n, [...(byPhone.get(n) ?? []), child]);

    // Short phones anywhere in the parent data.
    const stored: [string, string][] = [
      ['father_phone', child.father_phone], ['mother_phone', child.mother_phone], ['home_phone', child.home_phone],
      ['father_home_phone', child.cai.father_home_phone ?? ''], ['mother_home_phone', child.cai.mother_home_phone ?? ''],
      ['father_office_phone', child.cai.father_office_phone ?? ''], ['mother_office_phone', child.cai.mother_office_phone ?? ''],
    ];
    for (const [column, value] of stored) {
      if (clean(value) !== '' && normalizePhone(value) === '') {
        flag('SHORT_PHONE', { childIds: [child.id], detail: `${column} = '${clean(value)}'` });
      }
    }
  }

  // 2. Union children that share a phone and a surname; different surnames stay apart.
  const uf = new UnionFind();
  for (const [phone, kids] of byPhone) {
    const bySurname = new Map<string, LegacyChild[]>();
    for (const kid of kids) bySurname.set(key(kid.lname), [...(bySurname.get(key(kid.lname)) ?? []), kid]);
    for (const group of bySurname.values()) for (const kid of group.slice(1)) uf.union(group[0].id, kid.id);
    if (bySurname.size > 1) {
      flag('SHARED_PHONE_DIFFERENT_SURNAME', {
        childIds: kids.map((k) => k.id),
        phone,
        detail: [...bySurname.values()].map((g) => `${clean(g[0].lname) || '(no surname)'}: ${g.map((k) => k.id).join(' ')}`).join(' | '),
      });
    }
  }

  // 3. Households, in order of their lowest child id.
  const groups = new Map<number, LegacyChild[]>();
  for (const child of children) {
    const root = uf.find(child.id);
    groups.set(root, [...(groups.get(root) ?? []), child]);
  }
  const households: PlannedHousehold[] = [];
  const householdOfChild = new Map<number, number>();
  for (const kids of groups.values()) {
    const ref = households.length + 1;
    for (const kid of kids) householdOfChild.set(kid.id, ref);
    households.push(buildHousehold(ref, kids, flag, groupingPhones));
  }

  // 4. Phones shared by more than 2 households (after grouping).
  for (const [phone, kids] of byPhone) {
    const refs = [...new Set(kids.map((k) => householdOfChild.get(k.id)!))];
    if (refs.length > 2) {
      flag('PHONE_IN_MANY_HOUSEHOLDS', { householdRefs: refs, childIds: kids.map((k) => k.id), phone, detail: `${refs.length} households` });
    }
  }
  for (const item of review) {
    if (item.householdRefs.length === 0) {
      item.householdRefs = [...new Set(item.childIds.map((id) => householdOfChild.get(id)!))];
    }
  }
  return { households, review };
}

function buildHousehold(
  ref: number,
  kids: LegacyChild[],
  flag: (code: ReviewCode, item: Omit<ReviewItem, 'code' | 'householdRefs' | 'phone'> & Partial<ReviewItem>) => void,
  groupingPhones: Map<number, Set<string>>,
): PlannedHousehold {
  const childIds = kids.map((k) => k.id);

  if (kids.length > 1) {
    const counts = new Map<string, number>();
    for (const kid of kids) for (const p of groupingPhones.get(kid.id)!) counts.set(p, (counts.get(p) ?? 0) + 1);
    const shared = [...counts].filter(([, n]) => n > 1).map(([p]) => p);
    flag('MERGED_SIBLINGS', {
      householdRefs: [ref], childIds, phone: shared.join(' '),
      detail: `${kids.length} children, surname ${clean(kids[0].lname)}`,
    });
  }

  // Name: the father's surname, else the child's.
  const name = mostCommon(kids.map((k) => clean(k.cai.father_lname))) || clean(kids[0].lname);

  // household_phone: the children's home_phone.
  const homePhones = kids.map((k) => clean(k.home_phone));
  const householdPhone = mostCommon(homePhones);
  const distinctHome = new Set(homePhones.filter((p) => p !== '').map((p) => normalizePhone(p) || p));
  if (distinctHome.size > 1) {
    flag('HOME_PHONE_CONFLICT', { householdRefs: [ref], childIds, detail: [...distinctHome].join(' / ') });
  }

  // Siblings' parent_email.
  const emails = new Set(kids.map((k) => key(k.parent_email)).filter((e) => e !== ''));
  if (emails.size > 1) {
    flag('SIBLING_EMAIL_CONFLICT', { householdRefs: [ref], childIds, detail: `parent_email: ${[...emails].join(' / ')}` });
  }

  // People per slot, deduplicated across siblings by phone + name.
  const people: PlannedPerson[] = [];
  const rights: PlannedRights[] = [];
  const slotPeople: Record<Slot, Map<string, { person: PlannedPerson; data: SlotData; firstChild: number }>> = {
    father: new Map(), mother: new Map(),
  };
  for (const slot of ['father', 'mother'] as const) {
    const keysByChild = new Map<number, string>();
    for (const kid of kids) {
      const d = slotData(kid, slot);
      if (!hasData(d)) { keysByChild.set(kid.id, '(nobody)'); continue; }
      const k = personKey(d);
      keysByChild.set(kid.id, k);
      const existing = slotPeople[slot].get(k);
      if (!existing) {
        const person = newPerson(slot, d);
        slotPeople[slot].set(k, { person, data: d, firstChild: kid.id });
        people.push(person);
        continue;
      }
      if (key(existing.data.email) !== key(d.email)) {
        flag('SIBLING_EMAIL_CONFLICT', {
          householdRefs: [ref], childIds: [existing.firstChild, kid.id],
          detail: `${slot} email: '${existing.data.email}' (child ${existing.firstChild}) vs '${d.email}' (child ${kid.id})`,
        });
      }
      const fields: (keyof SlotData)[] = ['fname', 'lname', 'homePhone', 'officePhone', 'address', 'workAddress', 'occupation', 'employer'];
      const differing = fields.filter((f) => key(existing.data[f]) !== key(d[f]));
      if (clean(existing.data.legacyName) !== clean(d.legacyName)) differing.unshift('legacyName');
      if (differing.length > 0) {
        flag('PERSON_DETAILS_DIFFER', {
          householdRefs: [ref], childIds: [existing.firstChild, kid.id],
          detail: `${slot}: ${differing.join(', ')} differ (child ${existing.firstChild} used)`,
        });
      }
    }
    if (kids.length > 1 && new Set(keysByChild.values()).size > 1) {
      flag('PARENT_DIFFERS_BETWEEN_SIBLINGS', {
        householdRefs: [ref], childIds,
        detail: `${slot}: ${[...keysByChild].map(([id, k]) => `${id}=${k === '(nobody)' ? 'nobody' : slotPeople[slot].get(k)!.person.legacyFullName || k}`).join(', ')}`,
      });
    }
  }

  // Display order: fathers then mothers, by first appearance.
  let order = 0;
  for (const slot of ['father', 'mother'] as const) for (const { person } of slotPeople[slot].values()) person.sortOrder = order++;

  // Rights per child per parent; payment-responsible when the parent's email is parent_email.
  for (const kid of kids) {
    const payer = key(kid.parent_email);
    let anyPayer = false;
    for (const slot of ['father', 'mother'] as const) {
      const d = slotData(kid, slot);
      if (!hasData(d)) continue;
      const person = slotPeople[slot].get(personKey(d))!.person;
      const isPaymentResponsible = payer !== '' && key(d.email) === payer;
      anyPayer ||= isPaymentResponsible;
      rights.push({
        childId: kid.id,
        person,
        receivesNotifications: kid[`use_${slot}_phone_for_notification`] === 1,
        notifyMethod: kid[`notification_${slot}_phone_method`] ?? 'sms',
        isPaymentResponsible,
      });
    }
    if (payer !== '' && !anyPayer) {
      flag('PAYMENT_EMAIL_UNMATCHED', { householdRefs: [ref], childIds: [kid.id], detail: `parent_email '${clean(kid.parent_email)}'` });
    }
  }

  // Primary member: the parent who pays for the most children; none if nobody pays, so a
  // child with an empty parent_email keeps '' in the mirror.
  const paying = new Map<PlannedPerson, number>();
  for (const r of rights) if (r.isPaymentResponsible) paying.set(r.person, (paying.get(r.person) ?? 0) + 1);
  let primary: PlannedPerson | undefined;
  for (const [person, n] of paying) if (!primary || n > paying.get(primary)!) primary = person;
  if (primary) primary.isPrimary = true;

  return { ref, name, householdPhone, childIds, people, rights };
}
