-- Down step for the migration with the same name. Down runs in reverse order of up.
ALTER TABLE families
  DROP KEY idx_families_name,
  DROP KEY idx_families_household_norm,
  DROP COLUMN household_phone_normalized;
