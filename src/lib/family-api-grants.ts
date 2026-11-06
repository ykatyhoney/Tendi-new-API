import { quoteIdentifier } from './sql.js'

/**
 * Grants from the Family module design, section 6 / account table.
 * The combined dump does not contain the account SQL (it is applied after a password is set).
 * The lock trigger checks the account name, so both localhost and 127.0.0.1 are granted:
 * a pool pointed at 127.0.0.1 does not match 'user'@'localhost' on this server.
 */
export const FAMILY_API_HOSTS = ['localhost', '127.0.0.1'] as const

export const FAMILY_TABLES = [
  'families',
  'family_contacts',
  'family_contact_phones',
  'family_contact_emails',
  'family_contact_addresses',
  'family_members',
  'family_member_children',
] as const

/** family_id plus the 10 mirrored children columns. */
export const CHILDREN_UPDATE_COLUMNS = [
  'family_id',
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

/** The 18 mirrored children_additional_information columns. */
export const ADDITIONAL_UPDATE_COLUMNS = [
  'father_fname',
  'father_lname',
  'father_email',
  'father_home_phone',
  'father_office_phone',
  'father_address',
  'father_work_address',
  'father_occupation',
  'father_employer',
  'mother_fname',
  'mother_lname',
  'mother_email',
  'mother_home_phone',
  'mother_office_phone',
  'mother_address',
  'mother_work_address',
  'mother_occupation',
  'mother_employer',
] as const

export const ADMIN_READ_COLUMNS = [
  'id',
  'fname',
  'lname',
  'type',
  'status',
  'required_branches',
] as const

function account(host: string): string {
  return `'family_api'@'${host}'`
}

function columnList(columns: readonly string[]): string {
  return columns.map((column) => quoteIdentifier(column)).join(', ')
}

/** GRANT statements for one database. Does not create the account or set its password. */
export function familyApiGrantStatements(database: string): string[] {
  const db = quoteIdentifier(database)
  const statements: string[] = []
  for (const host of FAMILY_API_HOSTS) {
    const user = account(host)
    for (const table of FAMILY_TABLES) {
      statements.push(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ${db}.${quoteIdentifier(table)} TO ${user}`,
      )
    }
    statements.push(
      `GRANT SELECT, INSERT, UPDATE ON ${db}.${quoteIdentifier('relationship_types')} TO ${user}`,
    )
    statements.push(`GRANT SELECT ON ${db}.${quoteIdentifier('family_mirror_lock_log')} TO ${user}`)
    statements.push(
      `GRANT SELECT, UPDATE (${columnList(CHILDREN_UPDATE_COLUMNS)}) ON ${db}.${quoteIdentifier('children')} TO ${user}`,
    )
    statements.push(
      `GRANT SELECT, INSERT, UPDATE (${columnList(ADDITIONAL_UPDATE_COLUMNS)}) ON ${db}.${quoteIdentifier('children_additional_information')} TO ${user}`,
    )
    for (const table of ['classes', 'branches']) {
      statements.push(`GRANT SELECT ON ${db}.${quoteIdentifier(table)} TO ${user}`)
    }
    statements.push(`GRANT SELECT ON ${db}.${quoteIdentifier('admin_api_tokens')} TO ${user}`)
    // Staff auth updates last_seen_at. The account cannot insert or delete tokens.
    statements.push(
      `GRANT UPDATE (${quoteIdentifier('last_seen_at')}) ON ${db}.${quoteIdentifier('admin_api_tokens')} TO ${user}`,
    )
    statements.push(
      `GRANT SELECT (${columnList(ADMIN_READ_COLUMNS)}) ON ${db}.${quoteIdentifier('admin')} TO ${user}`,
    )
    statements.push(`GRANT INSERT ON ${db}.${quoteIdentifier('audit_logs')} TO ${user}`)
  }
  return statements
}
