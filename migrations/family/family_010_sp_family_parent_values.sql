-- Family module, PLAN.md "Legacy column mapping": the 13 values of one parent slot
-- (father or mother) for one child. Private helper of sp_family_mirror_values; reads only.
-- OUT types match the legacy target columns (children.*, children_additional_information.*).
-- Values longer than their target column raise an error instead of being truncated,
-- whatever the sql_mode.
DELIMITER //
CREATE PROCEDURE sp_family_parent_values(
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
COMMENT 'Family mirror: legacy values of one parent slot for one child (read-only helper)'
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

  SET o_name = '', o_phone = '', o_use_for_notification = NULL, o_notify_method = NULL,
      o_fname = '', o_lname = '', o_home_phone = '', o_email = '', o_address = '',
      o_occupation = '', o_employer = '', o_work_address = '', o_office_phone = '';

  IF p_member_id IS NULL THEN
    LEAVE body;
  END IF;

  SET v_person = (SELECT person_id FROM family_members WHERE id = p_member_id);

  -- Names, email, occupation, employer: from people.
  -- *_name: legacy_full_name as stored at seeding, else "fname lname" (empty parts skipped).
  SELECT IF(legacy_full_name <> '', legacy_full_name, CONCAT_WS(' ', NULLIF(fname, ''), NULLIF(lname, ''))),
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

  -- Notification flag and method: this parent's rights row for this child; NULL if none.
  SET o_use_for_notification = (SELECT receives_notifications <> 0 FROM family_member_children
                                 WHERE member_id = p_member_id AND child_id = p_child_id);
  SET o_notify_method = (SELECT notify_method FROM family_member_children
                          WHERE member_id = p_member_id AND child_id = p_child_id);

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
DELIMITER ;
