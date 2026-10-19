-- Family module, SCHEMA.md "Migration SQL". Charset/collation match `children` (utf8mb4 / utf8mb4_general_ci).
CREATE TABLE people (
  id               INT(11) NOT NULL AUTO_INCREMENT,
  fname            VARCHAR(100) NOT NULL DEFAULT '',
  lname            VARCHAR(100) NOT NULL DEFAULT '',
  legacy_full_name VARCHAR(100) NOT NULL DEFAULT '',
  hebrew_name      VARCHAR(255) NOT NULL DEFAULT '',
  email            VARCHAR(255) NOT NULL DEFAULT '',
  note             MEDIUMTEXT NULL,
  status           ENUM('active','trash') NOT NULL DEFAULT 'active',
  created_at       DATETIME NOT NULL,
  updated_at       DATETIME NOT NULL,
  created_by       INT(11) NOT NULL,
  updated_by       INT(11) NOT NULL,
  PRIMARY KEY (id),
  KEY idx_people_lname (lname, fname),
  KEY idx_people_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
