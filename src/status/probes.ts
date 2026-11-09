/*
 * The checks the status page runs against the API. Every endpoint is called, and none of them changes data:
 * - read: a real GET.
 * - no-op write: a save that resends the current values. It runs the whole write path (transaction, locks,
 *   mirror, audit, response) and must report affected_child_ids [] (a no-op writes 0 audit rows).
 * - expected error: a call whose correct answer is a known 4xx, used where a real call would create or link
 *   something (a duplicate code, a child linked to another family). It proves routing, auth, validation and the
 *   service's checks.
 * The writes run against a dedicated "Status check" household that the checker creates once (see checker.ts).
 */

export type ProbeKind = 'read' | 'no-op write' | 'expected error' | 'access'

export interface ProbeContext {
  familyId: number
  familyName: string
  householdPhone: string
  memberId: number
  memberSortOrder: number
  contactId: number
  contactNote: string | null
  phones: unknown[]
  emails: unknown[]
  addresses: unknown[]
  /** A child linked to another family, for the read and the ALREADY_LINKED checks. */
  linkedChildId: number
  fatherSortOrder: number
}

export interface ProbeResponse {
  status: number
  body: unknown
}

export interface Probe {
  id: string
  group: string
  name: string
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  /** The documented route, shown on the page. */
  route: string
  kind: ProbeKind
  /** What a pass proves, shown on the page. */
  note: string
  /** Sends the checker's staff token. Default true. */
  auth?: boolean
  /** Calls the public URL (nginx, TLS, Cloudflare) instead of the API directly. */
  publicUrl?: boolean
  path: (context: ProbeContext) => string
  body?: (context: ProbeContext) => unknown
  expectStatus: number
  expectCode?: string
  /** Extra check on the body. Returns a failure reason, or null. */
  check?: (body: unknown, context: ProbeContext) => string | null
}

/** The failure reason for a response, or null when it is what the probe expects. */
export function evaluate(probe: Probe, response: ProbeResponse, context: ProbeContext): string | null {
  if (response.status !== probe.expectStatus) {
    const code = codeOf(response.body)
    return `expected ${probe.expectStatus}${probe.expectCode === undefined ? '' : ` ${probe.expectCode}`}, got ${response.status}${code === undefined ? '' : ` ${code}`}`
  }
  if (probe.expectCode !== undefined && codeOf(response.body) !== probe.expectCode) {
    return `expected code ${probe.expectCode}, got ${codeOf(response.body) ?? 'none'}`
  }
  return probe.check === undefined ? null : probe.check(response.body, context)
}

function codeOf(body: unknown): string | undefined {
  const code = (body as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : undefined
}

function field(body: unknown, name: string): unknown {
  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>)[name] : undefined
}

/** A no-op save must not report changed children. */
function nothingWritten(body: unknown): string | null {
  const affected = field(body, 'affected_child_ids')
  return Array.isArray(affected) && affected.length === 0
    ? null
    : `the no-op save reported affected_child_ids ${JSON.stringify(affected)}`
}

function hasItem(predicate: (item: Record<string, unknown>) => boolean, what: string) {
  return (body: unknown): string | null => {
    const items = field(body, 'items')
    return Array.isArray(items) && items.some((item) => predicate(item as Record<string, unknown>)) ? null : `${what} is missing`
  }
}

const MAX_ID = 2147483647

export const PROBES: readonly Probe[] = [
  // Health
  {
    id: 'health-live', group: 'Health', name: 'Liveness', method: 'GET', route: '/api/v1/health/live', kind: 'read',
    note: 'The API process answers.', auth: false, path: () => '/api/v1/health/live', expectStatus: 200,
  },
  {
    id: 'health-ready', group: 'Health', name: 'Readiness', method: 'GET', route: '/api/v1/health', kind: 'read',
    note: 'The database answers and the family tables are there.', auth: false, path: () => '/api/v1/health',
    expectStatus: 200,
    check: (body) => (field(body, 'database') === 'ready' ? null : 'database is not ready'),
  },
  // Access
  {
    id: 'access-token', group: 'Access', name: 'Staff token required', method: 'GET', route: '/api/v1/families',
    kind: 'access', note: 'A request without a staff token is refused.', auth: false, path: () => '/api/v1/families',
    expectStatus: 401, expectCode: 'UNAUTHORIZED',
  },
  {
    id: 'access-public', group: 'Access', name: 'Public entry (HTTPS, password)', method: 'GET',
    route: '/api/v1/health/live', kind: 'access', publicUrl: true, auth: false,
    note: 'The public URL answers through Cloudflare, TLS and nginx, and asks for the password.',
    path: () => '/api/v1/health/live', expectStatus: 401,
  },
  // Families
  {
    id: 'families-search', group: 'Families', name: 'Search families', method: 'GET', route: '/api/v1/families',
    kind: 'read', note: 'Search finds the status household by name.',
    path: () => `/api/v1/families?q=${encodeURIComponent('Status check')}&pageSize=10`, expectStatus: 200,
    check: (body, context) => hasItem((item) => item['id'] === context.familyId, 'the status household')(body),
  },
  {
    id: 'families-get', group: 'Families', name: 'Get a family', method: 'GET', route: '/api/v1/families/{id}',
    kind: 'read', note: 'Family detail with members, contacts and rights.',
    path: (context) => `/api/v1/families/${context.familyId}`, expectStatus: 200,
  },
  {
    id: 'families-create', group: 'Families', name: 'Create a family', method: 'POST', route: '/api/v1/families',
    kind: 'expected error', note: 'A create without a name is refused by validation (nothing is created).',
    path: () => '/api/v1/families', body: () => ({}), expectStatus: 400, expectCode: 'VALIDATION',
  },
  {
    id: 'families-patch', group: 'Families', name: 'Update a family', method: 'PATCH', route: '/api/v1/families/{id}',
    kind: 'no-op write', note: 'Resending the name and household phone runs the full save and changes nothing.',
    path: (context) => `/api/v1/families/${context.familyId}`,
    body: (context) => ({ name: context.familyName, householdPhone: context.householdPhone }),
    expectStatus: 200, check: nothingWritten,
  },
  // Members
  {
    id: 'members-create', group: 'Members', name: 'Add a member', method: 'POST', route: '/api/v1/families/{id}/members',
    kind: 'expected error', note: 'Adding a contact who is already a member is refused (409 ALREADY_MEMBER).',
    path: (context) => `/api/v1/families/${context.familyId}/members`,
    body: (context) => ({ relationship: 'guardian', contactId: context.contactId }),
    expectStatus: 409, expectCode: 'ALREADY_MEMBER',
  },
  {
    id: 'members-patch', group: 'Members', name: 'Update a member', method: 'PATCH',
    route: '/api/v1/families/{id}/members/{memberId}', kind: 'no-op write',
    note: 'Resending the sort order runs the full save and changes nothing.',
    path: (context) => `/api/v1/families/${context.familyId}/members/${context.memberId}`,
    body: (context) => ({ sortOrder: context.memberSortOrder }), expectStatus: 200, check: nothingWritten,
  },
  {
    id: 'members-delete', group: 'Members', name: 'Remove a member', method: 'DELETE',
    route: '/api/v1/families/{id}/members/{memberId}', kind: 'expected error',
    note: 'Removing a member that does not exist is 404 (nothing is removed).',
    path: (context) => `/api/v1/families/${context.familyId}/members/${MAX_ID}`, expectStatus: 404,
    expectCode: 'NOT_FOUND',
  },
  // Contacts
  {
    id: 'contacts-search', group: 'Contacts', name: 'Search contacts', method: 'GET', route: '/api/v1/contacts',
    kind: 'read', note: 'Search finds the status contact by name.',
    path: () => `/api/v1/contacts?q=${encodeURIComponent('Statuscheck')}&pageSize=10`, expectStatus: 200,
    check: (body, context) => hasItem((item) => item['id'] === context.contactId, 'the status contact')(body),
  },
  {
    id: 'contacts-get', group: 'Contacts', name: 'Get a contact', method: 'GET', route: '/api/v1/contacts/{id}',
    kind: 'read', note: 'Contact detail with phones, emails, addresses and households.',
    path: (context) => `/api/v1/contacts/${context.contactId}`, expectStatus: 200,
  },
  {
    id: 'contacts-patch', group: 'Contacts', name: 'Update a contact', method: 'PATCH', route: '/api/v1/contacts/{id}',
    kind: 'no-op write', note: 'Resending the note runs the full save and changes nothing.',
    path: (context) => `/api/v1/contacts/${context.contactId}`, body: (context) => ({ note: context.contactNote }),
    expectStatus: 200, check: nothingWritten,
  },
  {
    id: 'contacts-phones', group: 'Contacts', name: 'Replace phones', method: 'PUT', route: '/api/v1/contacts/{id}/phones',
    kind: 'no-op write', note: 'Resending the phone list keeps every row and changes nothing.',
    path: (context) => `/api/v1/contacts/${context.contactId}/phones`, body: (context) => ({ phones: context.phones }),
    expectStatus: 200, check: nothingWritten,
  },
  {
    id: 'contacts-emails', group: 'Contacts', name: 'Replace emails', method: 'PUT', route: '/api/v1/contacts/{id}/emails',
    kind: 'no-op write', note: 'Resending the email list keeps every row and changes nothing.',
    path: (context) => `/api/v1/contacts/${context.contactId}/emails`, body: (context) => ({ emails: context.emails }),
    expectStatus: 200, check: nothingWritten,
  },
  {
    id: 'contacts-addresses', group: 'Contacts', name: 'Replace addresses', method: 'PUT',
    route: '/api/v1/contacts/{id}/addresses', kind: 'no-op write',
    note: 'Resending the address list keeps every row and changes nothing.',
    path: (context) => `/api/v1/contacts/${context.contactId}/addresses`,
    body: (context) => ({ addresses: context.addresses }), expectStatus: 200, check: nothingWritten,
  },
  // Children and links
  {
    id: 'children-family', group: 'Children and links', name: "A child's family", method: 'GET',
    route: '/api/v1/children/{childId}/family', kind: 'read', note: 'A linked child reads as linked, with its family.',
    path: (context) => `/api/v1/children/${context.linkedChildId}/family`, expectStatus: 200,
    check: (body) => (field(body, 'link') === 'linked' ? null : `link is ${String(field(body, 'link'))}`),
  },
  {
    id: 'links-preview', group: 'Children and links', name: 'Preview a link', method: 'GET',
    route: '/api/v1/families/{id}/children/{childId}/preview', kind: 'read',
    note: 'The 28 old parent columns, today and after linking. Writes nothing.',
    path: (context) => `/api/v1/families/${context.familyId}/children/${context.linkedChildId}/preview`,
    expectStatus: 200,
    check: (body) => {
      const columns = field(body, 'columns')
      return Array.isArray(columns) && columns.length === 28 ? null : 'the preview does not have 28 columns'
    },
  },
  {
    id: 'links-rights', group: 'Children and links', name: 'Replace rights', method: 'PUT',
    route: '/api/v1/families/{id}/children/{childId}/rights', kind: 'expected error',
    note: 'Rights for a child linked to another family are refused (409 ALREADY_LINKED).',
    path: (context) => `/api/v1/families/${context.familyId}/children/${context.linkedChildId}/rights`,
    body: (context) => ({
      rights: [
        {
          memberId: context.memberId, receivesNotifications: false, notifyMethod: 'voice', mayCollect: false,
          collectFrom: null, collectTo: null, isEmergency: false, isPaymentResponsible: false,
        },
      ],
    }),
    expectStatus: 409, expectCode: 'ALREADY_LINKED',
  },
  {
    id: 'links-link', group: 'Children and links', name: 'Link a child', method: 'POST',
    route: '/api/v1/families/{id}/children/{childId}/link', kind: 'expected error',
    note: 'Linking a child that belongs to another family is refused (409 ALREADY_LINKED).',
    path: (context) => `/api/v1/families/${context.familyId}/children/${context.linkedChildId}/link`,
    expectStatus: 409, expectCode: 'ALREADY_LINKED',
  },
  {
    id: 'links-unlink', group: 'Children and links', name: 'Unlink a child', method: 'POST',
    route: '/api/v1/children/{childId}/unlink', kind: 'expected error',
    note: 'Unlinking a child that does not exist is 404 (nothing is unlinked).',
    path: () => `/api/v1/children/${MAX_ID}/unlink`, expectStatus: 404, expectCode: 'NOT_FOUND',
  },
  // Relationship types
  {
    id: 'types-list', group: 'Relationship types', name: 'List relationship types', method: 'GET',
    route: '/api/v1/relationship-types', kind: 'read', note: 'The active dropdown, including father.',
    path: () => '/api/v1/relationship-types', expectStatus: 200,
    check: hasItem((item) => item['code'] === 'father', 'father'),
  },
  {
    id: 'types-create', group: 'Relationship types', name: 'Add a relationship type', method: 'POST',
    route: '/api/v1/relationship-types', kind: 'expected error',
    note: 'Adding a code that exists is refused (409 DUPLICATE_CODE).',
    path: () => '/api/v1/relationship-types', body: () => ({ code: 'father', label: 'Father', sortOrder: 1 }),
    expectStatus: 409, expectCode: 'DUPLICATE_CODE',
  },
  {
    id: 'types-patch', group: 'Relationship types', name: 'Update a relationship type', method: 'PATCH',
    route: '/api/v1/relationship-types/{code}', kind: 'no-op write',
    note: "Resending father's sort order runs the full save and changes nothing.",
    path: () => '/api/v1/relationship-types/father', body: (context) => ({ sortOrder: context.fatherSortOrder }),
    expectStatus: 200,
  },
]
