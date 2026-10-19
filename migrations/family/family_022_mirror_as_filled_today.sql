-- Family module, step 2.2: the mirror reproduces the legacy columns exactly as they are filled
-- today ("filled exactly as today", family-sync-proof.md). Replaces six objects created by
-- migrations 010-013, 017 and 018; the down step restores those definitions.
--   * home_send_notification is no longer mirrored or locked: the mirror owns 28 columns
--     (10 on children, 18 on children_additional_information) until production data shows its rule.
--   * *_name is people.legacy_full_name verbatim, including '' (no fname/lname fallback).
--   * No rights row (or no parent in the slot): use_*_phone_for_notification = 0 and
--     notification_*_phone_method = 'voice', the values the PHP app stores, instead of NULL.
--   * An empty children_additional_information value stays NULL where the stored value is NULL,
--     and is '' otherwise (older rows hold NULL; the PHP app writes '' today).
-- Several statements: CREATE OR REPLACE makes a partly applied run safe to re-run.
DELIMITER //

CREATE OR REPLACE PROCEDURE sp_family_parent_values(
  IN  p_member_id            INT,          -- family_members.id filling the slot; NULL = slot empty
  IN  p_child_id             INT,
  IN  p_household_phone      VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  IN  p_slot                 VARCHAR(6) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,  -- 'father' / 'mother', for messages
  OUT o_name                 VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,  -- children.*_name
  OUT o_phone                VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,  -- children.*_phone
  OUT o_use_for_notification BIT(1),                                                         -- children.use_*_phone_for_notification
  OUT o_notify_method        ENUM('sms','voice','both') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,  -- children.notification_*_phone_method
  OUT o_fname                VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,  -- children_additional_information.*_fname
  OUT o_lname                VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,  -- *_lname
  OUT o_home_phone           VARCHAR(30) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,   -- *_home_phone
  OUT o_email                VARCHAR(150) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,  -- *_email
  OUT o_address              VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,  -- *_address
  OUT o_occupation           VARCHAR(150) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,  -- *_occupation
  OUT o_employer             VARCHAR(150) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,  -- *_employer
  OUT o_work_address         VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,  -- *_work_address
  OUT o_office_phone         VARCHAR(30) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci    -- *_office_phone
)
READS SQL DATA
SQL SECURITY INVOKER
COMMENT 'Family mirror: legacy values of one parent slot for one child (read-only helper), v2'
body: BEGIN
  DECLARE v_person       INT;
  DECLARE v_name         VARCHAR(1000) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_email        VARCHAR(1000) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_home_phone   VARCHAR(1000) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_office_phone VARCHAR(1000) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_address      VARCHAR(1000) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_work_address VARCHAR(1000) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_too_long     VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_msg          VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;

  SET o_name = '', o_phone = '', o_use_for_notification = 0, o_notify_method = 'voice',
      o_fname = '', o_lname = '', o_home_phone = '', o_email = '', o_address = '',
      o_occupation = '', o_employer = '', o_work_address = '', o_office_phone = '';

  IF p_member_id IS NULL THEN
    LEAVE body;
  END IF;

  SET v_person = (SELECT person_id FROM family_members WHERE id = p_member_id);

  -- Names, email, occupation, employer: from people.
  -- *_name: legacy_full_name verbatim, including '' (no fallback to fname/lname), so an empty
  -- legacy name stays empty. Whoever creates a person (backfill, API) sets legacy_full_name.
  SELECT legacy_full_name,
         fname, lname, email, occupation, employer
    INTO v_name, o_fname, o_lname, v_email, o_occupation, o_employer
    FROM people WHERE id = v_person;

  -- children.*_phone: the primary phone as typed.
  SET o_phone = COALESCE(
    (SELECT phone FROM people_phones
      WHERE person_id = v_person AND is_primary = 1
      ORDER BY sort_order, id LIMIT 1), '');

  -- *_home_phone: the phone labelled home, else the household phone.
  SET v_home_phone = COALESCE(
    (SELECT phone FROM people_phones
      WHERE person_id = v_person AND label = 'home'
      ORDER BY is_primary DESC, sort_order, id LIMIT 1), p_household_phone);

  -- *_office_phone: the phone labelled work.
  SET v_office_phone = COALESCE(
    (SELECT phone FROM people_phones
      WHERE person_id = v_person AND label = 'work'
      ORDER BY is_primary DESC, sort_order, id LIMIT 1), '');

  -- *_address / *_work_address: "line1, line2, city, state zip", empty parts skipped.
  -- FORMAT PENDING APPROVAL: legacy values hold the street line only (no city, state or zip).
  SET v_address = COALESCE(
    (SELECT CONCAT_WS(', ', NULLIF(TRIM(line1), ''), NULLIF(TRIM(line2), ''), NULLIF(TRIM(city), ''),
                      NULLIF(TRIM(CONCAT_WS(' ', NULLIF(TRIM(state), ''), NULLIF(TRIM(zip), ''))), ''))
       FROM people_addresses
      WHERE person_id = v_person AND kind = 'home'
      ORDER BY id LIMIT 1), '');
  SET v_work_address = COALESCE(
    (SELECT CONCAT_WS(', ', NULLIF(TRIM(line1), ''), NULLIF(TRIM(line2), ''), NULLIF(TRIM(city), ''),
                      NULLIF(TRIM(CONCAT_WS(' ', NULLIF(TRIM(state), ''), NULLIF(TRIM(zip), ''))), ''))
       FROM people_addresses
      WHERE person_id = v_person AND kind = 'work'
      ORDER BY id LIMIT 1), '');

  -- Notification flag and method: this parent's rights row for this child; without one, the
  -- legacy values for "no notifications": 0 and 'voice' (what the PHP app stores).
  SET o_use_for_notification = COALESCE((SELECT receives_notifications <> 0 FROM family_member_children
                                          WHERE member_id = p_member_id AND child_id = p_child_id), 0);
  SET o_notify_method = COALESCE((SELECT notify_method FROM family_member_children
                                   WHERE member_id = p_member_id AND child_id = p_child_id), 'voice');

  SET v_too_long = CASE
    WHEN CHAR_LENGTH(v_name) > 100         THEN CONCAT('children.', p_slot, '_name (100)')
    WHEN CHAR_LENGTH(v_email) > 150        THEN CONCAT('children_additional_information.', p_slot, '_email (150)')
    WHEN CHAR_LENGTH(v_home_phone) > 30    THEN CONCAT('children_additional_information.', p_slot, '_home_phone (30)')
    WHEN CHAR_LENGTH(v_office_phone) > 30  THEN CONCAT('children_additional_information.', p_slot, '_office_phone (30)')
    WHEN CHAR_LENGTH(v_address) > 255      THEN CONCAT('children_additional_information.', p_slot, '_address (255)')
    WHEN CHAR_LENGTH(v_work_address) > 255 THEN CONCAT('children_additional_information.', p_slot, '_work_address (255)')
  END;
  IF v_too_long IS NOT NULL THEN
    SET v_msg = CONCAT('Family value too long for ', v_too_long, ', child ', p_child_id);
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = v_msg;
  END IF;

  SET o_name = v_name, o_email = v_email, o_home_phone = v_home_phone,
      o_office_phone = v_office_phone, o_address = v_address, o_work_address = v_work_address;
END//

CREATE OR REPLACE PROCEDURE sp_family_mirror_values(
  IN  p_child_id                          INT,
  IN  p_family_id                         INT,  -- NULL = children.family_id (preview of an unlinked child passes a family)
  -- children (10; home_send_notification is not mirrored)
  OUT o_father_name                       VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  OUT o_mother_name                       VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  OUT o_father_phone                      VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  OUT o_mother_phone                      VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  OUT o_home_phone                        VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  OUT o_parent_email                      VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  OUT o_use_father_phone_for_notification BIT(1),
  OUT o_use_mother_phone_for_notification BIT(1),
  OUT o_notification_father_phone_method  ENUM('sms','voice','both') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  OUT o_notification_mother_phone_method  ENUM('sms','voice','both') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  -- children_additional_information (18)
  OUT o_father_fname                      VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  OUT o_father_lname                      VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  OUT o_father_home_phone                 VARCHAR(30) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  OUT o_father_email                      VARCHAR(150) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  OUT o_father_address                    VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  OUT o_father_occupation                 VARCHAR(150) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  OUT o_father_employer                   VARCHAR(150) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  OUT o_father_work_address               VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  OUT o_father_office_phone               VARCHAR(30) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  OUT o_mother_fname                      VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  OUT o_mother_lname                      VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  OUT o_mother_home_phone                 VARCHAR(30) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  OUT o_mother_email                      VARCHAR(150) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  OUT o_mother_address                    VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  OUT o_mother_occupation                 VARCHAR(150) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  OUT o_mother_employer                   VARCHAR(150) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  OUT o_mother_work_address               VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  OUT o_mother_office_phone               VARCHAR(30) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci
)
READS SQL DATA
SQL SECURITY INVOKER
COMMENT 'Family mirror: the 28 legacy parent values for one child (read-only)'
BEGIN
  DECLARE v_family_id       INT;
  DECLARE v_household_phone VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_father_member   INT;
  DECLARE v_mother_member   INT;
  DECLARE v_msg             VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE n_father_fname        BOOLEAN DEFAULT FALSE;
  DECLARE n_father_lname        BOOLEAN DEFAULT FALSE;
  DECLARE n_father_home_phone   BOOLEAN DEFAULT FALSE;
  DECLARE n_father_email        BOOLEAN DEFAULT FALSE;
  DECLARE n_father_address      BOOLEAN DEFAULT FALSE;
  DECLARE n_father_occupation   BOOLEAN DEFAULT FALSE;
  DECLARE n_father_employer     BOOLEAN DEFAULT FALSE;
  DECLARE n_father_work_address BOOLEAN DEFAULT FALSE;
  DECLARE n_father_office_phone BOOLEAN DEFAULT FALSE;
  DECLARE n_mother_fname        BOOLEAN DEFAULT FALSE;
  DECLARE n_mother_lname        BOOLEAN DEFAULT FALSE;
  DECLARE n_mother_home_phone   BOOLEAN DEFAULT FALSE;
  DECLARE n_mother_email        BOOLEAN DEFAULT FALSE;
  DECLARE n_mother_address      BOOLEAN DEFAULT FALSE;
  DECLARE n_mother_occupation   BOOLEAN DEFAULT FALSE;
  DECLARE n_mother_employer     BOOLEAN DEFAULT FALSE;
  DECLARE n_mother_work_address BOOLEAN DEFAULT FALSE;
  DECLARE n_mother_office_phone BOOLEAN DEFAULT FALSE;

  IF NOT EXISTS (SELECT 1 FROM children WHERE id = p_child_id) THEN
    SET v_msg = CONCAT('Child ', COALESCE(p_child_id, 'NULL'), ' does not exist');
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = v_msg;
  END IF;

  SET v_family_id = COALESCE(p_family_id, (SELECT family_id FROM children WHERE id = p_child_id));
  IF v_family_id IS NULL THEN
    SET v_msg = CONCAT('Child ', p_child_id, ' is not linked to a family and no family was given');
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = v_msg;
  END IF;

  SET v_household_phone = (SELECT household_phone FROM families WHERE id = v_family_id AND status = 'active');
  IF v_household_phone IS NULL THEN
    SET v_msg = CONCAT('Family ', v_family_id, ' does not exist or is not active');
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = v_msg;
  END IF;

  SET v_father_member = (
    SELECT fm.id FROM family_members fm JOIN people p ON p.id = fm.person_id
     WHERE fm.family_id = v_family_id AND fm.status = 'active' AND p.status = 'active'
       AND fm.relationship IN ('father', 'step_father')
     ORDER BY fm.relationship <> 'father', fm.sort_order, fm.id LIMIT 1);
  SET v_mother_member = (
    SELECT fm.id FROM family_members fm JOIN people p ON p.id = fm.person_id
     WHERE fm.family_id = v_family_id AND fm.status = 'active' AND p.status = 'active'
       AND fm.relationship IN ('mother', 'step_mother')
     ORDER BY fm.relationship <> 'mother', fm.sort_order, fm.id LIMIT 1);

  CALL sp_family_parent_values(v_father_member, p_child_id, v_household_phone, 'father',
    o_father_name, o_father_phone, o_use_father_phone_for_notification, o_notification_father_phone_method,
    o_father_fname, o_father_lname, o_father_home_phone, o_father_email, o_father_address,
    o_father_occupation, o_father_employer, o_father_work_address, o_father_office_phone);
  CALL sp_family_parent_values(v_mother_member, p_child_id, v_household_phone, 'mother',
    o_mother_name, o_mother_phone, o_use_mother_phone_for_notification, o_notification_mother_phone_method,
    o_mother_fname, o_mother_lname, o_mother_home_phone, o_mother_email, o_mother_address,
    o_mother_occupation, o_mother_employer, o_mother_work_address, o_mother_office_phone);

  SET o_home_phone = v_household_phone;

  -- parent_email: the payment-responsible member for this child, else the household's
  -- primary member, else ''. Ties go to the lowest sort_order, then the lowest id.
  SET o_parent_email = COALESCE(
    (SELECT p.email
       FROM family_member_children fmc
       JOIN family_members fm ON fm.id = fmc.member_id
       JOIN people p ON p.id = fm.person_id
      WHERE fmc.child_id = p_child_id AND fmc.is_payment_responsible = 1
        AND fm.family_id = v_family_id AND fm.status = 'active' AND p.status = 'active'
      ORDER BY fm.sort_order, fm.id LIMIT 1),
    (SELECT p.email
       FROM family_members fm
       JOIN people p ON p.id = fm.person_id
      WHERE fm.family_id = v_family_id AND fm.is_primary = 1
        AND fm.status = 'active' AND p.status = 'active'
      ORDER BY fm.sort_order, fm.id LIMIT 1),
    '');

  -- Empty children_additional_information values in the legacy representation: older rows
  -- hold NULL, rows the PHP app writes today hold ''. An empty value stays NULL where the stored
  -- value is NULL and is '' otherwise (including a row that does not exist yet, D4).
  IF EXISTS (SELECT 1 FROM children_additional_information WHERE child_id = p_child_id) THEN
    SELECT father_fname IS NULL,
           father_lname IS NULL,
           father_home_phone IS NULL,
           father_email IS NULL,
           father_address IS NULL,
           father_occupation IS NULL,
           father_employer IS NULL,
           father_work_address IS NULL,
           father_office_phone IS NULL,
           mother_fname IS NULL,
           mother_lname IS NULL,
           mother_home_phone IS NULL,
           mother_email IS NULL,
           mother_address IS NULL,
           mother_occupation IS NULL,
           mother_employer IS NULL,
           mother_work_address IS NULL,
           mother_office_phone IS NULL
      INTO n_father_fname,
           n_father_lname,
           n_father_home_phone,
           n_father_email,
           n_father_address,
           n_father_occupation,
           n_father_employer,
           n_father_work_address,
           n_father_office_phone,
           n_mother_fname,
           n_mother_lname,
           n_mother_home_phone,
           n_mother_email,
           n_mother_address,
           n_mother_occupation,
           n_mother_employer,
           n_mother_work_address,
           n_mother_office_phone
      FROM children_additional_information WHERE child_id = p_child_id;
  END IF;
  IF o_father_fname = '' AND n_father_fname THEN SET o_father_fname = NULL; END IF;
  IF o_father_lname = '' AND n_father_lname THEN SET o_father_lname = NULL; END IF;
  IF o_father_home_phone = '' AND n_father_home_phone THEN SET o_father_home_phone = NULL; END IF;
  IF o_father_email = '' AND n_father_email THEN SET o_father_email = NULL; END IF;
  IF o_father_address = '' AND n_father_address THEN SET o_father_address = NULL; END IF;
  IF o_father_occupation = '' AND n_father_occupation THEN SET o_father_occupation = NULL; END IF;
  IF o_father_employer = '' AND n_father_employer THEN SET o_father_employer = NULL; END IF;
  IF o_father_work_address = '' AND n_father_work_address THEN SET o_father_work_address = NULL; END IF;
  IF o_father_office_phone = '' AND n_father_office_phone THEN SET o_father_office_phone = NULL; END IF;
  IF o_mother_fname = '' AND n_mother_fname THEN SET o_mother_fname = NULL; END IF;
  IF o_mother_lname = '' AND n_mother_lname THEN SET o_mother_lname = NULL; END IF;
  IF o_mother_home_phone = '' AND n_mother_home_phone THEN SET o_mother_home_phone = NULL; END IF;
  IF o_mother_email = '' AND n_mother_email THEN SET o_mother_email = NULL; END IF;
  IF o_mother_address = '' AND n_mother_address THEN SET o_mother_address = NULL; END IF;
  IF o_mother_occupation = '' AND n_mother_occupation THEN SET o_mother_occupation = NULL; END IF;
  IF o_mother_employer = '' AND n_mother_employer THEN SET o_mother_employer = NULL; END IF;
  IF o_mother_work_address = '' AND n_mother_work_address THEN SET o_mother_work_address = NULL; END IF;
  IF o_mother_office_phone = '' AND n_mother_office_phone THEN SET o_mother_office_phone = NULL; END IF;

  -- home_send_notification is not mirrored: it stays as stored until production data shows its
  -- rule (SCHEMA.md).
END//

CREATE OR REPLACE PROCEDURE sp_family_preview(
  IN p_child_id  INT,
  IN p_family_id INT  -- NULL = children.family_id; pass a family to preview an unlinked child
)
READS SQL DATA
SQL SECURITY INVOKER
COMMENT 'Family mirror: the 28 legacy parent values for one child as one row (read-only)'
BEGIN
  DECLARE v_father_name                       VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_mother_name                       VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_father_phone                      VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_mother_phone                      VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_home_phone                        VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_parent_email                      VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_use_father_phone_for_notification BIT(1);
  DECLARE v_use_mother_phone_for_notification BIT(1);
  DECLARE v_notification_father_phone_method  ENUM('sms','voice','both') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_notification_mother_phone_method  ENUM('sms','voice','both') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_father_fname                      VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_father_lname                      VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_father_home_phone                 VARCHAR(30) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_father_email                      VARCHAR(150) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_father_address                    VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_father_occupation                 VARCHAR(150) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_father_employer                   VARCHAR(150) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_father_work_address               VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_father_office_phone               VARCHAR(30) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_mother_fname                      VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_mother_lname                      VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_mother_home_phone                 VARCHAR(30) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_mother_email                      VARCHAR(150) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_mother_address                    VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_mother_occupation                 VARCHAR(150) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_mother_employer                   VARCHAR(150) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_mother_work_address               VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_mother_office_phone               VARCHAR(30) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;

  CALL sp_family_mirror_values(p_child_id, p_family_id,
    v_father_name, v_mother_name, v_father_phone, v_mother_phone, v_home_phone, v_parent_email,
    v_use_father_phone_for_notification, v_use_mother_phone_for_notification,
    v_notification_father_phone_method, v_notification_mother_phone_method,
    v_father_fname, v_father_lname, v_father_home_phone, v_father_email, v_father_address,
    v_father_occupation, v_father_employer, v_father_work_address, v_father_office_phone,
    v_mother_fname, v_mother_lname, v_mother_home_phone, v_mother_email, v_mother_address,
    v_mother_occupation, v_mother_employer, v_mother_work_address, v_mother_office_phone);

  SELECT
    v_father_name                       AS father_name,
    v_mother_name                       AS mother_name,
    v_father_phone                      AS father_phone,
    v_mother_phone                      AS mother_phone,
    v_home_phone                        AS home_phone,
    v_parent_email                      AS parent_email,
    v_use_father_phone_for_notification AS use_father_phone_for_notification,
    v_use_mother_phone_for_notification AS use_mother_phone_for_notification,
    v_notification_father_phone_method  AS notification_father_phone_method,
    v_notification_mother_phone_method  AS notification_mother_phone_method,
    v_father_fname                      AS father_fname,
    v_father_lname                      AS father_lname,
    v_father_home_phone                 AS father_home_phone,
    v_father_email                      AS father_email,
    v_father_address                    AS father_address,
    v_father_occupation                 AS father_occupation,
    v_father_employer                   AS father_employer,
    v_father_work_address               AS father_work_address,
    v_father_office_phone               AS father_office_phone,
    v_mother_fname                      AS mother_fname,
    v_mother_lname                      AS mother_lname,
    v_mother_home_phone                 AS mother_home_phone,
    v_mother_email                      AS mother_email,
    v_mother_address                    AS mother_address,
    v_mother_occupation                 AS mother_occupation,
    v_mother_employer                   AS mother_employer,
    v_mother_work_address               AS mother_work_address,
    v_mother_office_phone               AS mother_office_phone;
END//

CREATE OR REPLACE PROCEDURE sp_family_mirror(IN p_child_id INT)
MODIFIES SQL DATA
SQL SECURITY DEFINER
COMMENT 'Family mirror: writes the 28 legacy parent columns of one linked child'
body: BEGIN
  DECLARE v_family_id                         INT;
  DECLARE v_father_name                       VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_mother_name                       VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_father_phone                      VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_mother_phone                      VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_home_phone                        VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_parent_email                      VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_use_father_phone_for_notification BIT(1);
  DECLARE v_use_mother_phone_for_notification BIT(1);
  DECLARE v_notification_father_phone_method  ENUM('sms','voice','both') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_notification_mother_phone_method  ENUM('sms','voice','both') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_father_fname                      VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_father_lname                      VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_father_home_phone                 VARCHAR(30) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_father_email                      VARCHAR(150) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_father_address                    VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_father_occupation                 VARCHAR(150) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_father_employer                   VARCHAR(150) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_father_work_address               VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_father_office_phone               VARCHAR(30) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_mother_fname                      VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_mother_lname                      VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_mother_home_phone                 VARCHAR(30) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_mother_email                      VARCHAR(150) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_mother_address                    VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_mother_occupation                 VARCHAR(150) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_mother_employer                   VARCHAR(150) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_mother_work_address               VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_mother_office_phone               VARCHAR(30) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;

  DECLARE EXIT HANDLER FOR SQLEXCEPTION
  BEGIN
    SET @family_mirror = NULL;
    RESIGNAL;
  END;

  SET v_family_id = (SELECT family_id FROM children WHERE id = p_child_id);
  IF v_family_id IS NULL THEN
    LEAVE body;
  END IF;

  CALL sp_family_mirror_values(p_child_id, v_family_id,
    v_father_name, v_mother_name, v_father_phone, v_mother_phone, v_home_phone, v_parent_email,
    v_use_father_phone_for_notification, v_use_mother_phone_for_notification,
    v_notification_father_phone_method, v_notification_mother_phone_method,
    v_father_fname, v_father_lname, v_father_home_phone, v_father_email, v_father_address,
    v_father_occupation, v_father_employer, v_father_work_address, v_father_office_phone,
    v_mother_fname, v_mother_lname, v_mother_home_phone, v_mother_email, v_mother_address,
    v_mother_occupation, v_mother_employer, v_mother_work_address, v_mother_office_phone);

  SET @family_mirror = 1;

  UPDATE children SET
    father_name                       = v_father_name,
    mother_name                       = v_mother_name,
    father_phone                      = v_father_phone,
    mother_phone                      = v_mother_phone,
    home_phone                        = v_home_phone,
    parent_email                      = v_parent_email,
    use_father_phone_for_notification = v_use_father_phone_for_notification,
    use_mother_phone_for_notification = v_use_mother_phone_for_notification,
    notification_father_phone_method  = v_notification_father_phone_method,
    notification_mother_phone_method  = v_notification_mother_phone_method
  WHERE id = p_child_id;

  IF EXISTS (SELECT 1 FROM children_additional_information WHERE child_id = p_child_id) THEN
    UPDATE children_additional_information SET
      father_fname        = v_father_fname,
      father_lname        = v_father_lname,
      father_home_phone   = v_father_home_phone,
      father_email        = v_father_email,
      father_address      = v_father_address,
      father_occupation   = v_father_occupation,
      father_employer     = v_father_employer,
      father_work_address = v_father_work_address,
      father_office_phone = v_father_office_phone,
      mother_fname        = v_mother_fname,
      mother_lname        = v_mother_lname,
      mother_home_phone   = v_mother_home_phone,
      mother_email        = v_mother_email,
      mother_address      = v_mother_address,
      mother_occupation   = v_mother_occupation,
      mother_employer     = v_mother_employer,
      mother_work_address = v_mother_work_address,
      mother_office_phone = v_mother_office_phone
    WHERE child_id = p_child_id;
  ELSE
    -- Decision D4: create the missing row (4 children had none on 2026-09-24).
    INSERT INTO children_additional_information (
      child_id,
      father_fname, father_lname, father_home_phone, father_email, father_address,
      father_occupation, father_employer, father_work_address, father_office_phone,
      mother_fname, mother_lname, mother_home_phone, mother_email, mother_address,
      mother_occupation, mother_employer, mother_work_address, mother_office_phone,
      created_by, created_at, updated_by, updated_at)
    VALUES (
      p_child_id,
      v_father_fname, v_father_lname, v_father_home_phone, v_father_email, v_father_address,
      v_father_occupation, v_father_employer, v_father_work_address, v_father_office_phone,
      v_mother_fname, v_mother_lname, v_mother_home_phone, v_mother_email, v_mother_address,
      v_mother_occupation, v_mother_employer, v_mother_work_address, v_mother_office_phone,
      COALESCE(@audit_user, 0), NOW(), COALESCE(@audit_user, 0), NOW());
  END IF;

  SET @family_mirror = NULL;
END//

CREATE OR REPLACE PROCEDURE sp_family_mirror_cai(IN p_child_id INT, IN p_family_id INT)
MODIFIES SQL DATA
SQL SECURITY DEFINER
COMMENT 'Family mirror: writes the 18 children_additional_information parent columns of one child'
body: BEGIN
  DECLARE v_father_name                       VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_mother_name                       VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_father_phone                      VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_mother_phone                      VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_home_phone                        VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_parent_email                      VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_use_father_phone_for_notification BIT(1);
  DECLARE v_use_mother_phone_for_notification BIT(1);
  DECLARE v_notification_father_phone_method  ENUM('sms','voice','both') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_notification_mother_phone_method  ENUM('sms','voice','both') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_father_fname                      VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_father_lname                      VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_father_home_phone                 VARCHAR(30) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_father_email                      VARCHAR(150) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_father_address                    VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_father_occupation                 VARCHAR(150) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_father_employer                   VARCHAR(150) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_father_work_address               VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_father_office_phone               VARCHAR(30) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_mother_fname                      VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_mother_lname                      VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_mother_home_phone                 VARCHAR(30) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_mother_email                      VARCHAR(150) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_mother_address                    VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_mother_occupation                 VARCHAR(150) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_mother_employer                   VARCHAR(150) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_mother_work_address               VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_mother_office_phone               VARCHAR(30) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;

  DECLARE EXIT HANDLER FOR SQLEXCEPTION
  BEGIN
    SET @family_mirror = NULL;
    RESIGNAL;
  END;

  IF p_family_id IS NULL THEN
    LEAVE body;
  END IF;

  CALL sp_family_mirror_values(p_child_id, p_family_id,
    v_father_name, v_mother_name, v_father_phone, v_mother_phone, v_home_phone, v_parent_email,
    v_use_father_phone_for_notification, v_use_mother_phone_for_notification,
    v_notification_father_phone_method, v_notification_mother_phone_method,
    v_father_fname, v_father_lname, v_father_home_phone, v_father_email,
    v_father_address, v_father_occupation, v_father_employer, v_father_work_address,
    v_father_office_phone, v_mother_fname, v_mother_lname, v_mother_home_phone, v_mother_email,
    v_mother_address, v_mother_occupation, v_mother_employer, v_mother_work_address,
    v_mother_office_phone);

  SET @family_mirror = 1;

  IF EXISTS (SELECT 1 FROM children_additional_information WHERE child_id = p_child_id) THEN
    UPDATE children_additional_information SET
      father_fname        = v_father_fname,
      father_lname        = v_father_lname,
      father_home_phone   = v_father_home_phone,
      father_email        = v_father_email,
      father_address      = v_father_address,
      father_occupation   = v_father_occupation,
      father_employer     = v_father_employer,
      father_work_address = v_father_work_address,
      father_office_phone = v_father_office_phone,
      mother_fname        = v_mother_fname,
      mother_lname        = v_mother_lname,
      mother_home_phone   = v_mother_home_phone,
      mother_email        = v_mother_email,
      mother_address      = v_mother_address,
      mother_occupation   = v_mother_occupation,
      mother_employer     = v_mother_employer,
      mother_work_address = v_mother_work_address,
      mother_office_phone = v_mother_office_phone
    WHERE child_id = p_child_id;
  ELSE
    INSERT INTO children_additional_information (
      child_id,
      father_fname, father_lname, father_home_phone, father_email, father_address, father_occupation,
      father_employer, father_work_address, father_office_phone, mother_fname, mother_lname,
      mother_home_phone, mother_email, mother_address, mother_occupation, mother_employer,
      mother_work_address, mother_office_phone,
      created_by, created_at, updated_by, updated_at)
    VALUES (
      p_child_id,
      v_father_fname, v_father_lname, v_father_home_phone, v_father_email, v_father_address,
      v_father_occupation, v_father_employer, v_father_work_address, v_father_office_phone,
      v_mother_fname, v_mother_lname, v_mother_home_phone, v_mother_email, v_mother_address,
      v_mother_occupation, v_mother_employer, v_mother_work_address, v_mother_office_phone,
      COALESCE(@audit_user, 0), NOW(), COALESCE(@audit_user, 0), NOW());
  END IF;

  SET @family_mirror = NULL;
END//

CREATE OR REPLACE TRIGGER trg_children_family_bu BEFORE UPDATE ON children FOR EACH ROW
body: BEGIN
  DECLARE v_father_name                       VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_mother_name                       VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_father_phone                      VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_mother_phone                      VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_home_phone                        VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_parent_email                      VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_use_father_phone_for_notification BIT(1);
  DECLARE v_use_mother_phone_for_notification BIT(1);
  DECLARE v_notification_father_phone_method  ENUM('sms','voice','both') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_notification_mother_phone_method  ENUM('sms','voice','both') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_father_fname                      VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_father_lname                      VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_father_home_phone                 VARCHAR(30) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_father_email                      VARCHAR(150) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_father_address                    VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_father_occupation                 VARCHAR(150) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_father_employer                   VARCHAR(150) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_father_work_address               VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_father_office_phone               VARCHAR(30) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_mother_fname                      VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_mother_lname                      VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_mother_home_phone                 VARCHAR(30) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_mother_email                      VARCHAR(150) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_mother_address                    VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_mother_occupation                 VARCHAR(150) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_mother_employer                   VARCHAR(150) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_mother_work_address               VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_mother_office_phone               VARCHAR(30) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_db_user VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;

  IF NEW.family_id IS NULL THEN
    LEAVE body;  -- unlinked, or being unlinked: the child form owns the columns
  END IF;

  IF NOT (NEW.family_id <=> OLD.family_id) THEN
    -- a. Linking (or moving to another family): mirror the 11 children columns onto this row.
    CALL sp_family_mirror_values(NEW.id, NEW.family_id,
      v_father_name, v_mother_name, v_father_phone, v_mother_phone, v_home_phone, v_parent_email,
      v_use_father_phone_for_notification, v_use_mother_phone_for_notification,
      v_notification_father_phone_method, v_notification_mother_phone_method,
      v_father_fname, v_father_lname, v_father_home_phone, v_father_email,
      v_father_address, v_father_occupation, v_father_employer, v_father_work_address,
      v_father_office_phone, v_mother_fname, v_mother_lname, v_mother_home_phone, v_mother_email,
      v_mother_address, v_mother_occupation, v_mother_employer, v_mother_work_address,
      v_mother_office_phone);
    SET NEW.father_name                       = v_father_name;
    SET NEW.mother_name                       = v_mother_name;
    SET NEW.father_phone                      = v_father_phone;
    SET NEW.mother_phone                      = v_mother_phone;
    SET NEW.home_phone                        = v_home_phone;
    SET NEW.parent_email                      = v_parent_email;
    SET NEW.use_father_phone_for_notification = v_use_father_phone_for_notification;
    SET NEW.use_mother_phone_for_notification = v_use_mother_phone_for_notification;
    SET NEW.notification_father_phone_method  = v_notification_father_phone_method;
    SET NEW.notification_mother_phone_method  = v_notification_mother_phone_method;
  ELSEIF @family_mirror IS NULL THEN
    -- b. Legacy write to a linked child: keep the mirrored values, log each attempted change.
    SET v_db_user = LEFT(USER(), 128);
    IF NOT (NEW.father_name <=> OLD.father_name) THEN
      INSERT INTO family_mirror_lock_log (child_id, table_name, col_name, attempted_value, kept_value, db_user)
      VALUES (OLD.id, 'children', 'father_name', NEW.father_name, OLD.father_name, v_db_user);
      SET NEW.father_name = OLD.father_name;
    END IF;
    IF NOT (NEW.mother_name <=> OLD.mother_name) THEN
      INSERT INTO family_mirror_lock_log (child_id, table_name, col_name, attempted_value, kept_value, db_user)
      VALUES (OLD.id, 'children', 'mother_name', NEW.mother_name, OLD.mother_name, v_db_user);
      SET NEW.mother_name = OLD.mother_name;
    END IF;
    IF NOT (NEW.father_phone <=> OLD.father_phone) THEN
      INSERT INTO family_mirror_lock_log (child_id, table_name, col_name, attempted_value, kept_value, db_user)
      VALUES (OLD.id, 'children', 'father_phone', NEW.father_phone, OLD.father_phone, v_db_user);
      SET NEW.father_phone = OLD.father_phone;
    END IF;
    IF NOT (NEW.mother_phone <=> OLD.mother_phone) THEN
      INSERT INTO family_mirror_lock_log (child_id, table_name, col_name, attempted_value, kept_value, db_user)
      VALUES (OLD.id, 'children', 'mother_phone', NEW.mother_phone, OLD.mother_phone, v_db_user);
      SET NEW.mother_phone = OLD.mother_phone;
    END IF;
    IF NOT (NEW.home_phone <=> OLD.home_phone) THEN
      INSERT INTO family_mirror_lock_log (child_id, table_name, col_name, attempted_value, kept_value, db_user)
      VALUES (OLD.id, 'children', 'home_phone', NEW.home_phone, OLD.home_phone, v_db_user);
      SET NEW.home_phone = OLD.home_phone;
    END IF;
    IF NOT (NEW.parent_email <=> OLD.parent_email) THEN
      INSERT INTO family_mirror_lock_log (child_id, table_name, col_name, attempted_value, kept_value, db_user)
      VALUES (OLD.id, 'children', 'parent_email', NEW.parent_email, OLD.parent_email, v_db_user);
      SET NEW.parent_email = OLD.parent_email;
    END IF;
    IF NOT (NEW.use_father_phone_for_notification <=> OLD.use_father_phone_for_notification) THEN
      INSERT INTO family_mirror_lock_log (child_id, table_name, col_name, attempted_value, kept_value, db_user)
      VALUES (OLD.id, 'children', 'use_father_phone_for_notification', NEW.use_father_phone_for_notification + 0, OLD.use_father_phone_for_notification + 0, v_db_user);
      SET NEW.use_father_phone_for_notification = OLD.use_father_phone_for_notification;
    END IF;
    IF NOT (NEW.use_mother_phone_for_notification <=> OLD.use_mother_phone_for_notification) THEN
      INSERT INTO family_mirror_lock_log (child_id, table_name, col_name, attempted_value, kept_value, db_user)
      VALUES (OLD.id, 'children', 'use_mother_phone_for_notification', NEW.use_mother_phone_for_notification + 0, OLD.use_mother_phone_for_notification + 0, v_db_user);
      SET NEW.use_mother_phone_for_notification = OLD.use_mother_phone_for_notification;
    END IF;
    IF NOT (NEW.notification_father_phone_method <=> OLD.notification_father_phone_method) THEN
      INSERT INTO family_mirror_lock_log (child_id, table_name, col_name, attempted_value, kept_value, db_user)
      VALUES (OLD.id, 'children', 'notification_father_phone_method', NEW.notification_father_phone_method, OLD.notification_father_phone_method, v_db_user);
      SET NEW.notification_father_phone_method = OLD.notification_father_phone_method;
    END IF;
    IF NOT (NEW.notification_mother_phone_method <=> OLD.notification_mother_phone_method) THEN
      INSERT INTO family_mirror_lock_log (child_id, table_name, col_name, attempted_value, kept_value, db_user)
      VALUES (OLD.id, 'children', 'notification_mother_phone_method', NEW.notification_mother_phone_method, OLD.notification_mother_phone_method, v_db_user);
      SET NEW.notification_mother_phone_method = OLD.notification_mother_phone_method;
    END IF;
  END IF;
END//

DELIMITER ;
