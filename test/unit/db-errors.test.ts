import { describe, expect, it } from 'vitest'
import { mapDatabaseError } from '../../src/lib/db-errors.js'

function databaseError(errno: number, sqlMessage: string) {
  return Object.assign(new Error(sqlMessage), {
    errno,
    sqlMessage,
    sql: 'INSERT INTO family_members (note) VALUES (\'secret-row\')',
  })
}

describe('MariaDB error mapping', () => {
  it('maps a second primary phone, email, or address to 409 SECOND_PRIMARY', () => {
    for (const key of ['uq_fcp_primary', 'uq_fce_primary', 'uq_fca_primary']) {
      const body = mapDatabaseError(databaseError(1062, `Duplicate entry '9' for key '${key}'`))
      expect(body).toMatchObject({ statusCode: 409, code: 'SECOND_PRIMARY' })
      expect(JSON.stringify(body)).not.toContain('secret-row')
    }
  })

  it('maps a duplicate membership to 409 ALREADY_MEMBER', () => {
    const body = mapDatabaseError(
      databaseError(1062, "Duplicate entry '1-2' for key 'family_members.uniq_fm'"),
    )
    expect(body).toMatchObject({ statusCode: 409, code: 'ALREADY_MEMBER', details: { constraint: 'uniq_fm' } })
  })

  it('maps duplicate child rights to 409 DUPLICATE_RIGHTS', () => {
    const body = mapDatabaseError(databaseError(1062, "Duplicate entry '4-8' for key 'uniq_fmc'"))
    expect(body).toMatchObject({ statusCode: 409, code: 'DUPLICATE_RIGHTS' })
  })

  it('maps an other-type check failure to 400 TYPE_LABEL_NOT_ALLOWED', () => {
    for (const check of ['chk_fcp_type_label', 'chk_fce_type_label', 'chk_fca_type_label']) {
      const body = mapDatabaseError(
        databaseError(4025, `CONSTRAINT \`${check}\` failed for \`tendi_family_dev\`.\`family_contact_phones\``),
      )
      expect(body).toMatchObject({ statusCode: 400, code: 'TYPE_LABEL_NOT_ALLOWED' })
    }
  })

  it('maps an unknown relationship to 400 UNKNOWN_RELATIONSHIP', () => {
    const body = mapDatabaseError(
      databaseError(
        1452,
        'Cannot add or update a child row: a foreign key constraint fails (`tendi_family_dev`.`family_members`, CONSTRAINT `fk_fm_relationship` FOREIGN KEY (`relationship`) REFERENCES `relationship_types` (`code`))',
      ),
    )
    expect(body).toMatchObject({ statusCode: 400, code: 'UNKNOWN_RELATIONSHIP' })
  })

  it('maps a restricted delete to 409 IN_USE', () => {
    const body = mapDatabaseError(
      databaseError(
        1451,
        'Cannot delete or update a parent row: a foreign key constraint fails (`tendi_family_dev`.`family_members`, CONSTRAINT `fk_fm_family` FOREIGN KEY (`family_id`) REFERENCES `families` (`id`))',
      ),
    )
    expect(body).toMatchObject({ statusCode: 409, code: 'IN_USE', details: { constraint: 'fk_fm_family' } })
    expect(JSON.stringify(body)).not.toContain('INSERT')
  })

  it('maps a value the column refuses to 400 VALIDATION with the column, not the value', () => {
    const cases: [number, string, string][] = [
      [1264, "Out of range value for column 'sort_order' at row 1", 'sort_order'],
      [1048, "Column 'fname' cannot be null", 'fname'],
      [
        1366,
        "Incorrect string value: '\\xF0\\x9F\\x98\\x80' for column `tendi_family_dev`.`family_contacts`.`note` at row 1",
        'note',
      ],
    ]
    for (const [errno, message, column] of cases) {
      const body = mapDatabaseError(databaseError(errno, message))
      expect(body).toMatchObject({ statusCode: 400, code: 'VALIDATION', details: [{ path: `/${column}` }] })
      expect(JSON.stringify(body)).not.toContain('xF0')
      expect(JSON.stringify(body)).not.toContain('secret-row')
    }
  })

  it('leaves an unrecognized duplicate key unmapped', () => {
    expect(mapDatabaseError(databaseError(1062, "Duplicate entry 'a' for key 'uq_admin_token'"))).toBeNull()
  })
})

describe('logic fixes: MariaDB errors', () => {
  it('F6 maps a lock wait timeout (1205) and a repeated deadlock (1213) to 503 RETRY', () => {
    for (const [errno, message] of [
      [1205, 'Lock wait timeout exceeded; try restarting transaction'],
      [1213, 'Deadlock found when trying to get lock; try restarting transaction'],
    ] as const) {
      expect(mapDatabaseError(databaseError(errno, message))).toMatchObject({ statusCode: 503, code: 'RETRY' })
    }
  })

  it('F16 maps a too-long value (1406) to 409 VALUE_TOO_LONG with the column from the message', () => {
    const body = mapDatabaseError(databaseError(1406, "Data too long for column 'father_home_phone' at row 1"))
    expect(body).toMatchObject({ statusCode: 409, code: 'VALUE_TOO_LONG', details: { column: 'father_home_phone' } })
    expect(JSON.stringify(body)).not.toContain('secret-row')
  })
})
