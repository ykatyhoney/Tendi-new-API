-- Family module, SCHEMA.md "Migration SQL". NULL for every existing child. Adds a column only; no existing column changes.
ALTER TABLE children
  ADD COLUMN family_id INT(11) NULL DEFAULT NULL AFTER id,
  ADD KEY idx_children_family (family_id),
  ADD CONSTRAINT fk_children_family FOREIGN KEY (family_id) REFERENCES families (id) ON DELETE RESTRICT ON UPDATE CASCADE;
