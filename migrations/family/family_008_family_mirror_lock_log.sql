-- Family module, SCHEMA.md "Migration SQL". Charset/collation match `children` (utf8mb4 / utf8mb4_general_ci).
CREATE TABLE family_mirror_lock_log (
  id              INT(11) NOT NULL AUTO_INCREMENT,
  child_id        INT(11) NOT NULL,
  table_name      VARCHAR(64) NOT NULL,
  col_name        VARCHAR(64) NOT NULL,
  attempted_value TEXT NULL,
  kept_value      TEXT NULL,
  db_user         VARCHAR(128) NOT NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_lock_child (child_id),
  KEY idx_lock_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
