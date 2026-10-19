-- Family module, SCHEMA.md "Migration SQL". Charset/collation match `children` (utf8mb4 / utf8mb4_general_ci).
CREATE TABLE family_members (
  id           INT(11) NOT NULL AUTO_INCREMENT,
  family_id    INT(11) NOT NULL,
  person_id    INT(11) NOT NULL,
  relationship VARCHAR(32) NOT NULL,
  is_primary   TINYINT(1) NOT NULL DEFAULT 0,
  sort_order   INT(11) NOT NULL DEFAULT 0,
  status       ENUM('active','trash') NOT NULL DEFAULT 'active',
  PRIMARY KEY (id),
  UNIQUE KEY uniq_fm (family_id, person_id),
  KEY idx_fm_person (person_id),
  CONSTRAINT fk_fm_family FOREIGN KEY (family_id) REFERENCES families (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_fm_person FOREIGN KEY (person_id) REFERENCES people (id) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
