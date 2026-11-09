import type { RowDataPacket } from 'mysql2/promise'
import mysql from 'mysql2/promise'
import { afterAll, describe, expect, it } from 'vitest'
import { newContact } from '../../src/modules/family/schemas/common.js'
import {
  patchContactBody,
  replaceAddressesBody,
  replaceEmailsBody,
  replacePhonesBody,
} from '../../src/modules/family/schemas/contact.js'
import { createFamilyBody, patchFamilyBody } from '../../src/modules/family/schemas/family.js'
import { loadAdminConfig } from '../../scripts/mariadb-admin.js'

/*
 * F3 (I3, R8): every request field that is mirrored into an old column has a maxLength no longer than the
 * family column it is stored in and every old column it lands in. Lengths come from tendi_family_test.
 */

const TEST_DATABASE = 'tendi_family_test'
type Column = readonly [table: string, column: string]

const CAI = 'children_additional_information'
const NAMES = (part: 'fname' | 'lname'): Column[] => [
  ['family_contacts', part],
  [CAI, `father_${part}`],
  [CAI, `mother_${part}`],
]
const WORK = (part: 'occupation' | 'employer'): Column[] => [
  ['family_contacts', part],
  [CAI, `father_${part}`],
  [CAI, `mother_${part}`],
]
const ADDRESS = (part: string): Column[] => [
  ['family_contact_addresses', part],
  [CAI, 'father_address'],
  [CAI, 'father_work_address'],
  [CAI, 'mother_address'],
  [CAI, 'mother_work_address'],
]

/** TypeBox 1.x does not type schema options, so maxLength is read from the JSON schema object. */
const max = (schema: unknown): number | undefined => (schema as { maxLength?: number }).maxLength

const phoneItem = replacePhonesBody.properties.phones.items.properties
const emailItem = replaceEmailsBody.properties.emails.items.properties
const addressItem = replaceAddressesBody.properties.addresses.items.properties

/** [request field, its schema maxLength, the columns it is written to]. */
const FIELDS: [string, number | undefined, Column[]][] = [
  ['newContact.fname', max(newContact.properties.fname), NAMES('fname')],
  ['newContact.lname', max(newContact.properties.lname), NAMES('lname')],
  ['patchContact.fname', max(patchContactBody.properties.fname), NAMES('fname')],
  ['patchContact.lname', max(patchContactBody.properties.lname), NAMES('lname')],
  ['newContact.occupation', max(newContact.properties.occupation), WORK('occupation')],
  ['newContact.employer', max(newContact.properties.employer), WORK('employer')],
  ['patchContact.occupation', max(patchContactBody.properties.occupation), WORK('occupation')],
  ['patchContact.employer', max(patchContactBody.properties.employer), WORK('employer')],
  [
    'phones[].phone',
    max(phoneItem.phone),
    [
      ['family_contact_phones', 'phone'],
      ['children', 'father_phone'],
      ['children', 'mother_phone'],
      [CAI, 'father_home_phone'],
      [CAI, 'mother_home_phone'],
      [CAI, 'father_office_phone'],
      [CAI, 'mother_office_phone'],
    ],
  ],
  ...(['createFamily', 'patchFamily'] as const).map((name): [string, number | undefined, Column[]] => [
    `${name}.householdPhone`,
    max((name === 'createFamily' ? createFamilyBody : patchFamilyBody).properties.householdPhone),
    [
      ['families', 'household_phone'],
      ['children', 'home_phone'],
      [CAI, 'father_home_phone'],
      [CAI, 'mother_home_phone'],
    ],
  ]),
  [
    'emails[].email',
    max(emailItem.email),
    [
      ['family_contact_emails', 'email'],
      ['children', 'parent_email'],
      [CAI, 'father_email'],
      [CAI, 'mother_email'],
    ],
  ],
  ['addresses[].line1', max(addressItem.line1), ADDRESS('line1')],
  ['addresses[].line2', max(addressItem.line2), ADDRESS('line2')],
  ['addresses[].city', max(addressItem.city), ADDRESS('city')],
  ['addresses[].state', max(addressItem.state), ADDRESS('state')],
  ['addresses[].zip', max(addressItem.zip), ADDRESS('zip')],
]

const adminConfig = loadAdminConfig()
const connection = await mysql.createConnection({
  host: adminConfig.host,
  port: adminConfig.port,
  user: adminConfig.user,
  password: adminConfig.password,
  database: TEST_DATABASE,
})

describe('F3 request maxLength against the columns', () => {
  afterAll(async () => {
    await connection.end()
  })

  it('F3 no mirrored request field is longer than any column it is written to', async () => {
    const [found] = await connection.query<RowDataPacket[]>(
      `SELECT TABLE_NAME AS tableName, COLUMN_NAME AS columnName, CHARACTER_MAXIMUM_LENGTH AS maxLength
       FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ?`,
      [TEST_DATABASE],
    )
    const lengths = new Map(found.map((row) => [`${row['tableName']}.${row['columnName']}`, Number(row['maxLength'])]))
    const tooLong: string[] = []
    for (const [field, maxLength, columns] of FIELDS) {
      expect(maxLength, `${field} has no maxLength`).toBeTypeOf('number')
      for (const [table, column] of columns) {
        const limit = lengths.get(`${table}.${column}`)
        expect(limit, `${table}.${column} is not in ${TEST_DATABASE}`).toBeTypeOf('number')
        if (maxLength !== undefined && limit !== undefined && maxLength > limit) {
          tooLong.push(`${field} maxLength ${maxLength} > ${table}.${column} ${limit}`)
        }
      }
    }
    expect(tooLong).toEqual([])
  })
})
