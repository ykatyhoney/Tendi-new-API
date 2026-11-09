/**
 * Character limits of the old columns that request fields are mirrored into. Each request field's maxLength is
 * the narrowest old column it can land in, so a value that validates can always be mirrored.
 *
 * Read from tendi_family_test information_schema on 9 November 2026 and hardcoded here.
 * test/db/column-limits.test.ts fails if a schema maxLength is longer than any column a field is written to.
 */
export const OLD_COLUMN_LIMITS = {
  /** fname + ' ' + lname: children.father_name / mother_name and family_contacts.legacy_full_name, varchar(100). */
  fullName: 100,
  /** children_additional_information.father_fname, father_lname, mother_fname, mother_lname: varchar(100). */
  name: 100,
  /**
   * Any phone or householdPhone: children_additional_information.father_home_phone, mother_home_phone,
   * father_office_phone and mother_office_phone are varchar(30) (children.*_phone and home_phone are 255).
   */
  phone: 30,
  /** children_additional_information.father_email, mother_email: varchar(150) (children.parent_email is 255). */
  email: 150,
  /** children_additional_information.father_occupation, mother_occupation: varchar(150). */
  occupation: 150,
  /** children_additional_information.father_employer, mother_employer: varchar(150). */
  employer: 150,
  /**
   * The joined address (line1, line2, city, "state zip"): children_additional_information.father_address,
   * father_work_address, mother_address, mother_work_address, varchar(255). Checked when an address is saved.
   */
  joinedAddress: 255,
} as const
