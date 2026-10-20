-- Down step for the migration with the same name. Down runs in reverse order of up.
ALTER TABLE people
  DROP KEY idx_people_legacy_name,
  DROP KEY idx_people_fname;
