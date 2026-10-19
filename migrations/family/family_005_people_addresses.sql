-- Family module, SCHEMA.md "Migration SQL". Charset/collation match `children` (utf8mb4 / utf8mb4_general_ci).
CREATE TABLE people_addresses (
  id        INT(11) NOT NULL AUTO_INCREMENT,
  person_id INT(11) NOT NULL,
  kind      VARCHAR(32) NOT NULL DEFAULT 'home',
  line1     VARCHAR(255) NOT NULL DEFAULT '',
  line2     VARCHAR(255) NOT NULL DEFAULT '',
  city      VARCHAR(100) NOT NULL DEFAULT '',
  state     VARCHAR(25) NOT NULL DEFAULT '',
  zip       VARCHAR(15) NOT NULL DEFAULT '',
  PRIMARY KEY (id),
  KEY idx_pa_person (person_id),
  CONSTRAINT fk_pa_person FOREIGN KEY (person_id) REFERENCES people (id) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
