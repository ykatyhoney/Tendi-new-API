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

  it('leaves an unrecognized duplicate key unmapped', () => {
    expect(mapDatabaseError(databaseError(1062, "Duplicate entry 'a' for key 'uq_admin_token'"))).toBeNull()
  })
})
