-- Down step for the migration with the same name. Down runs in reverse order of up.
ALTER TABLE children
  DROP FOREIGN KEY fk_children_family,
  DROP KEY idx_children_family,
  DROP COLUMN family_id;
