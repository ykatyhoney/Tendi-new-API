-- Family module, SCHEMA.md "Migration SQL". Charset/collation match `children` (utf8mb4 / utf8mb4_general_ci).
CREATE TABLE people_phones (
  id               INT(11) NOT NULL AUTO_INCREMENT,
  person_id        INT(11) NOT NULL,
  phone            VARCHAR(255) NOT NULL,
  phone_normalized VARCHAR(20) NOT NULL,
  label            VARCHAR(32) NOT NULL DEFAULT 'mobile',
  channel          ENUM('none','sms','voice','both') NOT NULL DEFAULT 'sms',
  is_primary       TINYINT(1) NOT NULL DEFAULT 0,
  sort_order       INT(11) NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  KEY idx_pp_person (person_id, is_primary, sort_order),
  KEY idx_pp_norm (phone_normalized),
  CONSTRAINT fk_pp_person FOREIGN KEY (person_id) REFERENCES people (id) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
