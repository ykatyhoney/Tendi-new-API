-- =====================================================================
-- Tendi Family module: complete database script (MariaDB 10.11)
-- Revision 4, 2026-11-09 (family_id locked: a linked child can only be unlinked or
--   relinked by the Family API; closes the lock bypass found in the logic audit, I1)
-- Revision 3, 2026-10-28 (people renamed family_contacts)
--
-- Covers:
--   * the 8 family tables and family_mirror_lock_log
--     (design review of 2026-10-22: relationship_types table, family_contact_emails,
--      a type and one primary per person on phones, emails and addresses,
--      phone_normalized computed by the database, no per-child primary)
--   * P6: a name for the "Other" type (type_label) on phones, emails and addresses
--   * the relationship_types seed (19 types, 4 locked parent types)
--   * children.family_id, the per-child switch
--   * the three lock triggers on children and children_additional_information
--   * the family_api database account (section 6, commented out: set a password first)
--   * a rollback script (section 7, commented out)
--
-- Not in the database:
--   * The mirror itself. The Family API (Tendi-new-API) writes the 28 old parent
--     columns in the same transaction as each family save, with
--     SET @family_mirror = 1 before and SET @family_mirror = NULL in a finally block.
--   * P7, copying an address from the household or another contact. The screen
--     copies the values and the API saves a normal family_contact_addresses row; no schema change.
--   * No triggers on the family tables, no procedures, no events (no scheduled sync).
--
-- How to run: against ONE tenant database, as the migration account, e.g.
--   mariadb -u <migration_user> -p <tenant_db> < tendi_family_module.sql
-- Never run it against production until Gate C. On Galera, CREATE/ALTER/CREATE TRIGGER
-- pause writes cluster-wide (TOI): run outside bus hours.
-- This is a fresh install. If a tenant database already has an earlier version of
-- the family tables, run section 7 (rollback) first.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Households and contacts
-- ---------------------------------------------------------------------

-- 001 families: one row per household. Siblings = children with the same family_id.
CREATE TABLE families (
  id              INT(11) NOT NULL AUTO_INCREMENT,
  name            VARCHAR(100) NOT NULL,
  household_phone VARCHAR(255) NOT NULL DEFAULT '',   -- mirrored to children.home_phone
  status          ENUM('active','trash') NOT NULL DEFAULT 'active',
  created_at      DATETIME NOT NULL,
  updated_at      DATETIME NOT NULL,
  created_by      INT(11) NOT NULL,                   -- admin.id
  updated_by      INT(11) NOT NULL,                   -- admin.id
  PRIMARY KEY (id),
  KEY idx_families_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- 002 family_contacts: a person, stored once (parent, grandparent, babysitter, doctor).
-- Named family_contacts, not contacts: the existing contacts table holds staff.
CREATE TABLE family_contacts (
  id               INT(11) NOT NULL AUTO_INCREMENT,
  fname            VARCHAR(100) NOT NULL DEFAULT '',
  lname            VARCHAR(100) NOT NULL DEFAULT '',
  legacy_full_name VARCHAR(100) NOT NULL DEFAULT '',  -- exact father_name / mother_name at seeding; mirrored back verbatim
  hebrew_name      VARCHAR(255) NOT NULL DEFAULT '',
  occupation       VARCHAR(150) NOT NULL DEFAULT '',  -- mirrored to children_additional_information.*_occupation (D4)
  employer         VARCHAR(150) NOT NULL DEFAULT '',  -- mirrored to children_additional_information.*_employer (D4)
  note             MEDIUMTEXT NULL,
  status           ENUM('active','trash') NOT NULL DEFAULT 'active',
  created_at       DATETIME NOT NULL,
  updated_at       DATETIME NOT NULL,
  created_by       INT(11) NOT NULL,
  updated_by       INT(11) NOT NULL,
  PRIMARY KEY (id),
  KEY idx_fc_lname (lname, fname),
  KEY idx_fc_fname (fname),
  KEY idx_fc_legacy_name (legacy_full_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ---------------------------------------------------------------------
-- 2. Relationship types (the dropdown) and household members
-- ---------------------------------------------------------------------

-- 003a relationship_types: admin and superadmin add, rename, reorder or deactivate; never delete.
-- Only the 4 types with a parent_slot fill the old parent columns; they are locked in the API.
CREATE TABLE relationship_types (
  code        VARCHAR(32) NOT NULL,                   -- stored in family_members.relationship; never changes
  label       VARCHAR(64) NOT NULL,
  parent_slot ENUM('father','mother') NULL DEFAULT NULL,
  slot_rank   TINYINT NULL DEFAULT NULL,              -- lower wins in the slot: father/mother 1, step_* 2
  sort_order  INT(11) NOT NULL DEFAULT 0,
  status      ENUM('active','inactive') NOT NULL DEFAULT 'active',
  created_at  DATETIME NOT NULL,
  updated_at  DATETIME NOT NULL,
  created_by  INT(11) NOT NULL,
  updated_by  INT(11) NOT NULL,
  PRIMARY KEY (code),
  CONSTRAINT chk_rt_slot CHECK ((parent_slot IS NULL) = (slot_rank IS NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

INSERT INTO relationship_types
  (code, label, parent_slot, slot_rank, sort_order, created_at, updated_at, created_by, updated_by) VALUES
  ('father',        'Father',        'father', 1,    10,  NOW(), NOW(), 0, 0),
  ('mother',        'Mother',        'mother', 1,    20,  NOW(), NOW(), 0, 0),
  ('step_father',   'Stepfather',    'father', 2,    30,  NOW(), NOW(), 0, 0),
  ('step_mother',   'Stepmother',    'mother', 2,    40,  NOW(), NOW(), 0, 0),
  ('guardian',      'Guardian',      NULL,     NULL, 50,  NOW(), NOW(), 0, 0),
  ('foster_parent', 'Foster parent', NULL,     NULL, 60,  NOW(), NOW(), 0, 0),
  ('grandfather',   'Grandfather',   NULL,     NULL, 70,  NOW(), NOW(), 0, 0),
  ('grandmother',   'Grandmother',   NULL,     NULL, 80,  NOW(), NOW(), 0, 0),
  ('brother',       'Brother',       NULL,     NULL, 90,  NOW(), NOW(), 0, 0),
  ('sister',        'Sister',        NULL,     NULL, 100, NOW(), NOW(), 0, 0),
  ('uncle',         'Uncle',         NULL,     NULL, 110, NOW(), NOW(), 0, 0),
  ('aunt',          'Aunt',          NULL,     NULL, 120, NOW(), NOW(), 0, 0),
  ('cousin',        'Cousin',        NULL,     NULL, 130, NOW(), NOW(), 0, 0),
  ('nanny',         'Nanny',         NULL,     NULL, 140, NOW(), NOW(), 0, 0),
  ('babysitter',    'Babysitter',    NULL,     NULL, 150, NOW(), NOW(), 0, 0),
  ('car_service',   'Car service',   NULL,     NULL, 160, NOW(), NOW(), 0, 0),
  ('doctor',        'Doctor',        NULL,     NULL, 170, NOW(), NOW(), 0, 0),
  ('family_friend', 'Family friend', NULL,     NULL, 180, NOW(), NOW(), 0, 0),
  ('other',         'Other',         NULL,     NULL, 190, NOW(), NOW(), 0, 0);

-- 003b family_members: who is in which household, in what relationship.
-- The relationship and the household's primary member are set once per household.
CREATE TABLE family_members (
  id           INT(11) NOT NULL AUTO_INCREMENT,
  family_id    INT(11) NOT NULL,
  family_contact_id    INT(11) NOT NULL,
  relationship VARCHAR(32) NOT NULL,
  is_primary   TINYINT(1) NOT NULL DEFAULT 0,          -- fallback for whose email goes to children.parent_email
  sort_order   INT(11) NOT NULL DEFAULT 0,
  status       ENUM('active','trash') NOT NULL DEFAULT 'active',
  PRIMARY KEY (id),
  UNIQUE KEY uniq_fm (family_id, family_contact_id),
  KEY idx_fm_contact (family_contact_id),
  KEY idx_fm_relationship (relationship),
  CONSTRAINT fk_fm_family       FOREIGN KEY (family_id)    REFERENCES families (id)           ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_fm_contact      FOREIGN KEY (family_contact_id)    REFERENCES family_contacts (id)             ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_fm_relationship FOREIGN KEY (relationship) REFERENCES relationship_types (code) ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ---------------------------------------------------------------------
-- 3. Phones, emails and addresses of a contact
--    type + one primary per person (unique key on a computed column).
--    P6: type_label names an "Other" entry ("Grandma's cell", "Summer house");
--    the screen shows it in place of the type. Only allowed when type = 'other'.
-- ---------------------------------------------------------------------

-- 004 family_contact_phones
CREATE TABLE family_contact_phones (
  id                INT(11) NOT NULL AUTO_INCREMENT,
  family_contact_id         INT(11) NOT NULL,
  phone             VARCHAR(255) NOT NULL,             -- as typed; a mobile fills children.father_phone / mother_phone
  phone_normalized  VARCHAR(20) AS (
    CASE WHEN CHAR_LENGTH(REGEXP_REPLACE(REGEXP_REPLACE(phone, '(?i)(ext\\.?|x|#).*$', ''), '[^0-9]', '')) >= 10
         THEN RIGHT(REGEXP_REPLACE(REGEXP_REPLACE(phone, '(?i)(ext\\.?|x|#).*$', ''), '[^0-9]', ''), 10)
         ELSE '' END) STORED,                          -- last 10 digits, extension dropped; computed, never written
  type              ENUM('mobile','home','work','other') NOT NULL DEFAULT 'mobile',
  type_label        VARCHAR(50) NULL DEFAULT NULL,     -- P6: name of an "Other" phone
  channel           ENUM('none','sms','voice','both') NOT NULL DEFAULT 'sms',
  is_primary        TINYINT(1) NOT NULL DEFAULT 0,
  primary_family_contact_id INT(11) AS (IF(is_primary = 1, family_contact_id, NULL)) STORED,
  sort_order        INT(11) NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  KEY idx_fcp_contact (family_contact_id, is_primary, sort_order),
  KEY idx_fcp_norm (phone_normalized),
  UNIQUE KEY uq_fcp_primary (primary_family_contact_id),        -- one primary phone per person
  CONSTRAINT chk_fcp_type_label CHECK (type_label IS NULL OR (type = 'other' AND CHAR_LENGTH(TRIM(type_label)) > 0)),
  CONSTRAINT fk_fcp_contact FOREIGN KEY (family_contact_id) REFERENCES family_contacts (id) ON DELETE CASCADE ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- 004b family_contact_emails
CREATE TABLE family_contact_emails (
  id                INT(11) NOT NULL AUTO_INCREMENT,
  family_contact_id         INT(11) NOT NULL,
  email             VARCHAR(255) NOT NULL,             -- the primary one fills parent_email and *_email
  type              ENUM('personal','work','other') NOT NULL DEFAULT 'personal',
  type_label        VARCHAR(50) NULL DEFAULT NULL,     -- P6: name of an "Other" email
  is_primary        TINYINT(1) NOT NULL DEFAULT 0,
  primary_family_contact_id INT(11) AS (IF(is_primary = 1, family_contact_id, NULL)) STORED,
  sort_order        INT(11) NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  KEY idx_fce_contact (family_contact_id, is_primary, sort_order),
  UNIQUE KEY uq_fce_primary (primary_family_contact_id),        -- one primary email per person
  CONSTRAINT chk_fce_type_label CHECK (type_label IS NULL OR (type = 'other' AND CHAR_LENGTH(TRIM(type_label)) > 0)),
  CONSTRAINT fk_fce_contact FOREIGN KEY (family_contact_id) REFERENCES family_contacts (id) ON DELETE CASCADE ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- 005 family_contact_addresses (P7 "copy an address" saves a normal row here: a copy, not a reference)
CREATE TABLE family_contact_addresses (
  id                INT(11) NOT NULL AUTO_INCREMENT,
  family_contact_id         INT(11) NOT NULL,
  type              ENUM('home','work','billing','other') NOT NULL DEFAULT 'home',
  type_label        VARCHAR(50) NULL DEFAULT NULL,     -- P6: name of an "Other" address
  line1             VARCHAR(255) NOT NULL DEFAULT '',
  line2             VARCHAR(255) NOT NULL DEFAULT '',
  city              VARCHAR(100) NOT NULL DEFAULT '',
  state             VARCHAR(25)  NOT NULL DEFAULT '',
  zip               VARCHAR(15)  NOT NULL DEFAULT '',
  is_primary        TINYINT(1) NOT NULL DEFAULT 0,
  primary_family_contact_id INT(11) AS (IF(is_primary = 1, family_contact_id, NULL)) STORED,
  PRIMARY KEY (id),
  KEY idx_fca_contact (family_contact_id, is_primary),
  UNIQUE KEY uq_fca_primary (primary_family_contact_id),        -- one primary address per person
  CONSTRAINT chk_fca_type_label CHECK (type_label IS NULL OR (type = 'other' AND CHAR_LENGTH(TRIM(type_label)) > 0)),
  CONSTRAINT fk_fca_contact FOREIGN KEY (family_contact_id) REFERENCES family_contacts (id) ON DELETE CASCADE ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ---------------------------------------------------------------------
-- 4. Rights per child, the per-child switch, the lock log
-- ---------------------------------------------------------------------

-- 006 family_member_children: what one household member may do for one child.
CREATE TABLE family_member_children (
  id                     INT(11) NOT NULL AUTO_INCREMENT,
  member_id              INT(11) NOT NULL,
  child_id               INT(11) NOT NULL,
  receives_notifications TINYINT(1) NOT NULL DEFAULT 0,          -- -> children.use_*_phone_for_notification
  notify_method          ENUM('sms','voice','both') NOT NULL DEFAULT 'sms', -- -> children.notification_*_phone_method
  may_collect            TINYINT(1) NOT NULL DEFAULT 0,
  collect_from           DATE NULL,
  collect_to             DATE NULL,
  is_emergency           TINYINT(1) NOT NULL DEFAULT 0,
  is_payment_responsible TINYINT(1) NOT NULL DEFAULT 0,          -- picks whose email goes to children.parent_email
  PRIMARY KEY (id),
  UNIQUE KEY uniq_fmc (member_id, child_id),
  KEY idx_fmc_child (child_id),
  CONSTRAINT fk_fmc_member FOREIGN KEY (member_id) REFERENCES family_members (id) ON DELETE CASCADE  ON UPDATE CASCADE,
  CONSTRAINT fk_fmc_child  FOREIGN KEY (child_id)  REFERENCES children (id)       ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- 007 children.family_id: NULL for every existing child (today's behavior).
-- Set = the Family API's mirror service owns the 28 parent columns. Unset = rollback for that child.
-- Done in three steps so the children table is never rebuilt (no copy, no full lock;
-- also safe with the 0000-00-00 end_date values under a strict sql_mode).
-- Every family_id is NULL, so the foreign key has nothing to check while it is added.
ALTER TABLE children ADD COLUMN family_id INT(11) NULL DEFAULT NULL AFTER id, ALGORITHM=INSTANT;
ALTER TABLE children ADD KEY idx_children_family (family_id), ALGORITHM=INPLACE, LOCK=NONE;
SET @family_fk_checks = @@foreign_key_checks;
SET SESSION foreign_key_checks = 0;
ALTER TABLE children
  ADD CONSTRAINT fk_children_family FOREIGN KEY (family_id) REFERENCES families (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  ALGORITHM=INPLACE;
SET SESSION foreign_key_checks = @family_fk_checks;

-- 008 family_mirror_lock_log: one row each time a lock trigger puts back a write.
CREATE TABLE family_mirror_lock_log (
  id              INT(11) NOT NULL AUTO_INCREMENT,
  child_id        INT(11) NOT NULL,
  table_name      VARCHAR(64) NOT NULL,
  col_name        VARCHAR(64) NOT NULL,
  attempted_value TEXT NULL,
  kept_value      TEXT NULL,
  db_user         VARCHAR(128) NOT NULL,              -- USER(): the account that connected
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_mll_child (child_id),
  KEY idx_mll_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ---------------------------------------------------------------------
-- 5. The three lock triggers
--    For a linked child (family_id already set), a change to a mirrored column is
--    put back and logged, unless it comes from the family_api account with
--    @family_mirror = 1. The rest of the row saves normally. The flag alone, from any
--    other account (root included), does not open the lock.
--    family_id is locked the same way (revision 4): linking, relinking and unlinking
--    go through the Family API. Otherwise clearing family_id, writing a column and
--    setting family_id back would get past the lock. A new child row can't arrive
--    already linked either.
--    Emergency unlink of one child without the API (from any account; it is not put
--    back and not written to family_mirror_lock_log):
--      SET @family_unlink = 1;
--      UPDATE children SET family_id = NULL WHERE id = <child id>;
--      SET @family_unlink = NULL;
--    It only clears family_id. It can't link or relink a child.
-- ---------------------------------------------------------------------

DELIMITER $$

CREATE TRIGGER trg_children_family_bu BEFORE UPDATE ON children
FOR EACH ROW
BEGIN
  IF NOT (NEW.family_id <=> OLD.family_id)
     AND NOT (COALESCE(@family_mirror, 0) = 1 AND SUBSTRING_INDEX(USER(), '@', 1) = 'family_api')
     AND NOT (NEW.family_id IS NULL AND COALESCE(@family_unlink, 0) = 1) THEN
    INSERT INTO family_mirror_lock_log (child_id, table_name, col_name, attempted_value, kept_value, db_user)
      VALUES (OLD.id, 'children', 'family_id', CAST(NEW.family_id AS CHAR), CAST(OLD.family_id AS CHAR), USER());
    SET NEW.family_id = OLD.family_id;
  END IF;
  IF OLD.family_id IS NOT NULL
     AND NOT (COALESCE(@family_mirror, 0) = 1 AND SUBSTRING_INDEX(USER(), '@', 1) = 'family_api') THEN
    IF NOT (NEW.father_name <=> OLD.father_name) THEN
      INSERT INTO family_mirror_lock_log (child_id, table_name, col_name, attempted_value, kept_value, db_user)
        VALUES (OLD.id, 'children', 'father_name', NEW.father_name, OLD.father_name, USER());
      SET NEW.father_name = OLD.father_name;
    END IF;
    IF NOT (NEW.mother_name <=> OLD.mother_name) THEN
      INSERT INTO family_mirror_lock_log (child_id, table_name, col_name, attempted_value, kept_value, db_user)
        VALUES (OLD.id, 'children', 'mother_name', NEW.mother_name, OLD.mother_name, USER());
      SET NEW.mother_name = OLD.mother_name;
    END IF;
    IF NOT (NEW.father_phone <=> OLD.father_phone) THEN
      INSERT INTO family_mirror_lock_log (child_id, table_name, col_name, attempted_value, kept_value, db_user)
        VALUES (OLD.id, 'children', 'father_phone', NEW.father_phone, OLD.father_phone, USER());
      SET NEW.father_phone = OLD.father_phone;
    END IF;
    IF NOT (NEW.mother_phone <=> OLD.mother_phone) THEN
      INSERT INTO family_mirror_lock_log (child_id, table_name, col_name, attempted_value, kept_value, db_user)
        VALUES (OLD.id, 'children', 'mother_phone', NEW.mother_phone, OLD.mother_phone, USER());
      SET NEW.mother_phone = OLD.mother_phone;
    END IF;
    IF NOT (NEW.home_phone <=> OLD.home_phone) THEN
      INSERT INTO family_mirror_lock_log (child_id, table_name, col_name, attempted_value, kept_value, db_user)
        VALUES (OLD.id, 'children', 'home_phone', NEW.home_phone, OLD.home_phone, USER());
      SET NEW.home_phone = OLD.home_phone;
    END IF;
    IF NOT (NEW.parent_email <=> OLD.parent_email) THEN
      INSERT INTO family_mirror_lock_log (child_id, table_name, col_name, attempted_value, kept_value, db_user)
        VALUES (OLD.id, 'children', 'parent_email', NEW.parent_email, OLD.parent_email, USER());
      SET NEW.parent_email = OLD.parent_email;
    END IF;
    IF NOT (NEW.use_father_phone_for_notification <=> OLD.use_father_phone_for_notification) THEN
      INSERT INTO family_mirror_lock_log (child_id, table_name, col_name, attempted_value, kept_value, db_user)
        VALUES (OLD.id, 'children', 'use_father_phone_for_notification', CAST(NEW.use_father_phone_for_notification + 0 AS CHAR), CAST(OLD.use_father_phone_for_notification + 0 AS CHAR), USER());
      SET NEW.use_father_phone_for_notification = OLD.use_father_phone_for_notification;
    END IF;
    IF NOT (NEW.use_mother_phone_for_notification <=> OLD.use_mother_phone_for_notification) THEN
      INSERT INTO family_mirror_lock_log (child_id, table_name, col_name, attempted_value, kept_value, db_user)
        VALUES (OLD.id, 'children', 'use_mother_phone_for_notification', CAST(NEW.use_mother_phone_for_notification + 0 AS CHAR), CAST(OLD.use_mother_phone_for_notification + 0 AS CHAR), USER());
      SET NEW.use_mother_phone_for_notification = OLD.use_mother_phone_for_notification;
    END IF;
    IF NOT (NEW.notification_father_phone_method <=> OLD.notification_father_phone_method) THEN
      INSERT INTO family_mirror_lock_log (child_id, table_name, col_name, attempted_value, kept_value, db_user)
        VALUES (OLD.id, 'children', 'notification_father_phone_method', NEW.notification_father_phone_method, OLD.notification_father_phone_method, USER());
      SET NEW.notification_father_phone_method = OLD.notification_father_phone_method;
    END IF;
    IF NOT (NEW.notification_mother_phone_method <=> OLD.notification_mother_phone_method) THEN
      INSERT INTO family_mirror_lock_log (child_id, table_name, col_name, attempted_value, kept_value, db_user)
        VALUES (OLD.id, 'children', 'notification_mother_phone_method', NEW.notification_mother_phone_method, OLD.notification_mother_phone_method, USER());
      SET NEW.notification_mother_phone_method = OLD.notification_mother_phone_method;
    END IF;
  END IF;
END$$

CREATE TRIGGER trg_children_family_bi BEFORE INSERT ON children
FOR EACH ROW
BEGIN
  IF NEW.family_id IS NOT NULL
     AND NOT (COALESCE(@family_mirror, 0) = 1 AND SUBSTRING_INDEX(USER(), '@', 1) = 'family_api') THEN
    INSERT INTO family_mirror_lock_log (child_id, table_name, col_name, attempted_value, kept_value, db_user)
      VALUES (COALESCE(NEW.id, 0), 'children', 'family_id', CAST(NEW.family_id AS CHAR), NULL, USER());
    SET NEW.family_id = NULL;
  END IF;
END$$

CREATE TRIGGER trg_cai_family_bu BEFORE UPDATE ON children_additional_information
FOR EACH ROW
BEGIN
  DECLARE v_family_id INT DEFAULT NULL;
  SET v_family_id = (SELECT c.family_id FROM children c WHERE c.id = OLD.child_id);
  IF v_family_id IS NOT NULL
     AND NOT (COALESCE(@family_mirror, 0) = 1 AND SUBSTRING_INDEX(USER(), '@', 1) = 'family_api') THEN
    IF NOT (NEW.father_fname <=> OLD.father_fname) THEN
      INSERT INTO family_mirror_lock_log (child_id, table_name, col_name, attempted_value, kept_value, db_user)
        VALUES (OLD.child_id, 'children_additional_information', 'father_fname', NEW.father_fname, OLD.father_fname, USER());
      SET NEW.father_fname = OLD.father_fname;
    END IF;
    IF NOT (NEW.father_lname <=> OLD.father_lname) THEN
      INSERT INTO family_mirror_lock_log (child_id, table_name, col_name, attempted_value, kept_value, db_user)
        VALUES (OLD.child_id, 'children_additional_information', 'father_lname', NEW.father_lname, OLD.father_lname, USER());
      SET NEW.father_lname = OLD.father_lname;
    END IF;
    IF NOT (NEW.father_email <=> OLD.father_email) THEN
      INSERT INTO family_mirror_lock_log (child_id, table_name, col_name, attempted_value, kept_value, db_user)
        VALUES (OLD.child_id, 'children_additional_information', 'father_email', NEW.father_email, OLD.father_email, USER());
      SET NEW.father_email = OLD.father_email;
    END IF;
    IF NOT (NEW.father_home_phone <=> OLD.father_home_phone) THEN
      INSERT INTO family_mirror_lock_log (child_id, table_name, col_name, attempted_value, kept_value, db_user)
        VALUES (OLD.child_id, 'children_additional_information', 'father_home_phone', NEW.father_home_phone, OLD.father_home_phone, USER());
      SET NEW.father_home_phone = OLD.father_home_phone;
    END IF;
    IF NOT (NEW.father_office_phone <=> OLD.father_office_phone) THEN
      INSERT INTO family_mirror_lock_log (child_id, table_name, col_name, attempted_value, kept_value, db_user)
        VALUES (OLD.child_id, 'children_additional_information', 'father_office_phone', NEW.father_office_phone, OLD.father_office_phone, USER());
      SET NEW.father_office_phone = OLD.father_office_phone;
    END IF;
    IF NOT (NEW.father_address <=> OLD.father_address) THEN
      INSERT INTO family_mirror_lock_log (child_id, table_name, col_name, attempted_value, kept_value, db_user)
        VALUES (OLD.child_id, 'children_additional_information', 'father_address', NEW.father_address, OLD.father_address, USER());
      SET NEW.father_address = OLD.father_address;
    END IF;
    IF NOT (NEW.father_work_address <=> OLD.father_work_address) THEN
      INSERT INTO family_mirror_lock_log (child_id, table_name, col_name, attempted_value, kept_value, db_user)
        VALUES (OLD.child_id, 'children_additional_information', 'father_work_address', NEW.father_work_address, OLD.father_work_address, USER());
      SET NEW.father_work_address = OLD.father_work_address;
    END IF;
    IF NOT (NEW.father_occupation <=> OLD.father_occupation) THEN
      INSERT INTO family_mirror_lock_log (child_id, table_name, col_name, attempted_value, kept_value, db_user)
        VALUES (OLD.child_id, 'children_additional_information', 'father_occupation', NEW.father_occupation, OLD.father_occupation, USER());
      SET NEW.father_occupation = OLD.father_occupation;
    END IF;
    IF NOT (NEW.father_employer <=> OLD.father_employer) THEN
      INSERT INTO family_mirror_lock_log (child_id, table_name, col_name, attempted_value, kept_value, db_user)
        VALUES (OLD.child_id, 'children_additional_information', 'father_employer', NEW.father_employer, OLD.father_employer, USER());
      SET NEW.father_employer = OLD.father_employer;
    END IF;
    IF NOT (NEW.mother_fname <=> OLD.mother_fname) THEN
      INSERT INTO family_mirror_lock_log (child_id, table_name, col_name, attempted_value, kept_value, db_user)
        VALUES (OLD.child_id, 'children_additional_information', 'mother_fname', NEW.mother_fname, OLD.mother_fname, USER());
      SET NEW.mother_fname = OLD.mother_fname;
    END IF;
    IF NOT (NEW.mother_lname <=> OLD.mother_lname) THEN
      INSERT INTO family_mirror_lock_log (child_id, table_name, col_name, attempted_value, kept_value, db_user)
        VALUES (OLD.child_id, 'children_additional_information', 'mother_lname', NEW.mother_lname, OLD.mother_lname, USER());
      SET NEW.mother_lname = OLD.mother_lname;
    END IF;
    IF NOT (NEW.mother_email <=> OLD.mother_email) THEN
      INSERT INTO family_mirror_lock_log (child_id, table_name, col_name, attempted_value, kept_value, db_user)
        VALUES (OLD.child_id, 'children_additional_information', 'mother_email', NEW.mother_email, OLD.mother_email, USER());
      SET NEW.mother_email = OLD.mother_email;
    END IF;
    IF NOT (NEW.mother_home_phone <=> OLD.mother_home_phone) THEN
      INSERT INTO family_mirror_lock_log (child_id, table_name, col_name, attempted_value, kept_value, db_user)
        VALUES (OLD.child_id, 'children_additional_information', 'mother_home_phone', NEW.mother_home_phone, OLD.mother_home_phone, USER());
      SET NEW.mother_home_phone = OLD.mother_home_phone;
    END IF;
    IF NOT (NEW.mother_office_phone <=> OLD.mother_office_phone) THEN
      INSERT INTO family_mirror_lock_log (child_id, table_name, col_name, attempted_value, kept_value, db_user)
        VALUES (OLD.child_id, 'children_additional_information', 'mother_office_phone', NEW.mother_office_phone, OLD.mother_office_phone, USER());
      SET NEW.mother_office_phone = OLD.mother_office_phone;
    END IF;
    IF NOT (NEW.mother_address <=> OLD.mother_address) THEN
      INSERT INTO family_mirror_lock_log (child_id, table_name, col_name, attempted_value, kept_value, db_user)
        VALUES (OLD.child_id, 'children_additional_information', 'mother_address', NEW.mother_address, OLD.mother_address, USER());
      SET NEW.mother_address = OLD.mother_address;
    END IF;
    IF NOT (NEW.mother_work_address <=> OLD.mother_work_address) THEN
      INSERT INTO family_mirror_lock_log (child_id, table_name, col_name, attempted_value, kept_value, db_user)
        VALUES (OLD.child_id, 'children_additional_information', 'mother_work_address', NEW.mother_work_address, OLD.mother_work_address, USER());
      SET NEW.mother_work_address = OLD.mother_work_address;
    END IF;
    IF NOT (NEW.mother_occupation <=> OLD.mother_occupation) THEN
      INSERT INTO family_mirror_lock_log (child_id, table_name, col_name, attempted_value, kept_value, db_user)
        VALUES (OLD.child_id, 'children_additional_information', 'mother_occupation', NEW.mother_occupation, OLD.mother_occupation, USER());
      SET NEW.mother_occupation = OLD.mother_occupation;
    END IF;
    IF NOT (NEW.mother_employer <=> OLD.mother_employer) THEN
      INSERT INTO family_mirror_lock_log (child_id, table_name, col_name, attempted_value, kept_value, db_user)
        VALUES (OLD.child_id, 'children_additional_information', 'mother_employer', NEW.mother_employer, OLD.mother_employer, USER());
      SET NEW.mother_employer = OLD.mother_employer;
    END IF;
  END IF;
END$$

DELIMITER ;

-- ---------------------------------------------------------------------
-- 6. The family_api database account (run once per server; set the password first)
--    Unqualified table names grant on the current tenant database.
--    The API checks staff tokens in admin_api_tokens and writes an audit_logs row per write.
-- ---------------------------------------------------------------------
/*
CREATE USER IF NOT EXISTS 'family_api'@'localhost' IDENTIFIED BY '<set a strong password>';

GRANT SELECT, INSERT, UPDATE, DELETE ON families               TO 'family_api'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE ON family_contacts        TO 'family_api'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE ON family_members         TO 'family_api'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE ON family_member_children TO 'family_api'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE ON family_contact_phones          TO 'family_api'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE ON family_contact_emails          TO 'family_api'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE ON family_contact_addresses       TO 'family_api'@'localhost';
GRANT SELECT, INSERT, UPDATE         ON relationship_types     TO 'family_api'@'localhost';  -- never DELETE
GRANT SELECT                         ON family_mirror_lock_log TO 'family_api'@'localhost';  -- written by the triggers

GRANT SELECT ON children                        TO 'family_api'@'localhost';
GRANT SELECT ON children_additional_information TO 'family_api'@'localhost';
GRANT SELECT ON classes                         TO 'family_api'@'localhost';
GRANT SELECT ON branches                        TO 'family_api'@'localhost';
GRANT SELECT ON admin_api_tokens                TO 'family_api'@'localhost';
GRANT SELECT (id, fname, lname, type, status, required_branches) ON admin TO 'family_api'@'localhost';
GRANT INSERT ON audit_logs                      TO 'family_api'@'localhost';

-- Exactly children.family_id and the 10 mirrored columns on children
GRANT UPDATE (family_id, father_name, mother_name, father_phone, mother_phone, home_phone, parent_email, use_father_phone_for_notification, use_mother_phone_for_notification, notification_father_phone_method, notification_mother_phone_method)
  ON children TO 'family_api'@'localhost';
-- Exactly the 18 mirrored columns on children_additional_information, plus creating a missing row (D4)
GRANT UPDATE (father_fname, father_lname, father_email, father_home_phone, father_office_phone, father_address, father_work_address, father_occupation, father_employer, mother_fname, mother_lname, mother_email, mother_home_phone, mother_office_phone, mother_address, mother_work_address, mother_occupation, mother_employer)
  ON children_additional_information TO 'family_api'@'localhost';
GRANT INSERT ON children_additional_information TO 'family_api'@'localhost';
*/

-- ---------------------------------------------------------------------
-- 7. Rollback (down): the database goes back to the 2026-09-24 state
-- ---------------------------------------------------------------------
/*
DROP TRIGGER IF EXISTS trg_children_family_bu;
DROP TRIGGER IF EXISTS trg_children_family_bi;
DROP TRIGGER IF EXISTS trg_cai_family_bu;
ALTER TABLE children DROP FOREIGN KEY fk_children_family;
ALTER TABLE children DROP KEY idx_children_family;
ALTER TABLE children DROP COLUMN family_id;
DROP TABLE IF EXISTS family_mirror_lock_log;
DROP TABLE IF EXISTS family_member_children;
DROP TABLE IF EXISTS family_contact_addresses;
DROP TABLE IF EXISTS family_contact_emails;
DROP TABLE IF EXISTS family_contact_phones;
DROP TABLE IF EXISTS family_members;
DROP TABLE IF EXISTS relationship_types;
DROP TABLE IF EXISTS family_contacts;
DROP TABLE IF EXISTS families;
-- DROP USER IF EXISTS 'family_api'@'localhost';   -- only when no tenant on this server uses it
*/
