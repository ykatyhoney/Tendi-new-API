-- Family module, SCHEMA.md "Migration SQL". Charset/collation match `children` (utf8mb4 / utf8mb4_general_ci).
CREATE TABLE families (
  id              INT(11) NOT NULL AUTO_INCREMENT,
  name            VARCHAR(100) NOT NULL,
  household_phone VARCHAR(255) NOT NULL DEFAULT '',
  status          ENUM('active','trash') NOT NULL DEFAULT 'active',
  created_at      DATETIME NOT NULL,
  updated_at      DATETIME NOT NULL,
  created_by      INT(11) NOT NULL,
  updated_by      INT(11) NOT NULL,
  PRIMARY KEY (id),
  KEY idx_families_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
