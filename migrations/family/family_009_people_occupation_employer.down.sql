-- Down step for the migration with the same name. Down runs in reverse order of up.
ALTER TABLE people
  DROP COLUMN employer,
  DROP COLUMN occupation;
