-- Family module, SCHEMA.md "Migration SQL". Charset/collation match `children` (utf8mb4 / utf8mb4_general_ci).
CREATE TABLE family_member_children (
  id                     INT(11) NOT NULL AUTO_INCREMENT,
  member_id              INT(11) NOT NULL,
  child_id               INT(11) NOT NULL,
  is_primary             TINYINT(1) NOT NULL DEFAULT 0,
  receives_notifications TINYINT(1) NOT NULL DEFAULT 0,
  notify_method          ENUM('sms','voice','both') NOT NULL DEFAULT 'sms',
  may_collect            TINYINT(1) NOT NULL DEFAULT 0,
  collect_from           DATE NULL,
  collect_to             DATE NULL,
  is_emergency           TINYINT(1) NOT NULL DEFAULT 0,
  is_payment_responsible TINYINT(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_fmc (member_id, child_id),
  KEY idx_fmc_child (child_id),
  CONSTRAINT fk_fmc_member FOREIGN KEY (member_id) REFERENCES family_members (id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_fmc_child FOREIGN KEY (child_id) REFERENCES children (id) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
