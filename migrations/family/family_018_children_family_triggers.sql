-- Family module, SCHEMA.md "Database objects: mirror and lock": link and lock triggers on
-- children and children_additional_information.
--
-- trg_children_family_bu (children, BEFORE UPDATE)
--   a. family_id set or changed to a family: fills the 11 children columns on the row being
--      saved (SET NEW.col), because a trigger cannot UPDATE the table that fired it.
--   b. Linked child, family_id unchanged, @family_mirror not set (a legacy write): every
--      mirrored column the statement tries to change is put back to its old value and logged in
--      family_mirror_lock_log. Other columns save normally; no error (decision D2).
--   c. Unlinking (family_id -> NULL) changes nothing: the columns keep their last values.
-- trg_children_family_au (children, AFTER UPDATE, PRECEDES ra_children_au)
--   family_id set or changed to a family: writes the 18 children_additional_information columns
--   through sp_family_mirror_cai.
-- trg_cai_family_bu (children_additional_information, BEFORE UPDATE)
--   Child linked and @family_mirror not set: same revert and log for the 18 mirrored columns.
--
-- The ra_* audit triggers are AFTER triggers, so they always run after these BEFORE triggers and
-- record the values actually saved. db_user is USER() (the connected client): inside a trigger
-- CURRENT_USER() would be the trigger's definer.
-- Several statements in one migration: CREATE OR REPLACE here and DROP ... IF EXISTS in the
-- down step make a partly applied run safe to re-run.
DELIMITER //

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
  DECLARE v_home_send_notification            BIT(1);
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
      v_home_send_notification, v_father_fname, v_father_lname, v_father_home_phone, v_father_email,
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
    SET NEW.home_send_notification            = v_home_send_notification;
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
    IF NOT (NEW.home_send_notification <=> OLD.home_send_notification) THEN
      INSERT INTO family_mirror_lock_log (child_id, table_name, col_name, attempted_value, kept_value, db_user)
      VALUES (OLD.id, 'children', 'home_send_notification', NEW.home_send_notification + 0, OLD.home_send_notification + 0, v_db_user);
      SET NEW.home_send_notification = OLD.home_send_notification;
    END IF;
  END IF;
END//

CREATE OR REPLACE TRIGGER trg_children_family_au AFTER UPDATE ON children FOR EACH ROW PRECEDES ra_children_au
BEGIN
  IF NEW.family_id IS NOT NULL AND NOT (NEW.family_id <=> OLD.family_id) THEN
    CALL sp_family_mirror_cai(NEW.id, NEW.family_id);
  END IF;
END//

CREATE OR REPLACE TRIGGER trg_cai_family_bu BEFORE UPDATE ON children_additional_information FOR EACH ROW
body: BEGIN
  DECLARE v_db_user VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;

  IF @family_mirror IS NOT NULL
     OR (SELECT family_id FROM children WHERE id = NEW.child_id) IS NULL THEN
    LEAVE body;  -- a mirror write, or the child is not linked
  END IF;

  SET v_db_user = LEFT(USER(), 128);
  IF NOT (NEW.father_fname <=> OLD.father_fname) THEN
    INSERT INTO family_mirror_lock_log (child_id, table_name, col_name, attempted_value, kept_value, db_user)
    VALUES (OLD.child_id, 'children_additional_information', 'father_fname', NEW.father_fname, OLD.father_fname, v_db_user);
    SET NEW.father_fname = OLD.father_fname;
  END IF;
  IF NOT (NEW.father_lname <=> OLD.father_lname) THEN
    INSERT INTO family_mirror_lock_log (child_id, table_name, col_name, attempted_value, kept_value, db_user)
    VALUES (OLD.child_id, 'children_additional_information', 'father_lname', NEW.father_lname, OLD.father_lname, v_db_user);
    SET NEW.father_lname = OLD.father_lname;
  END IF;
  IF NOT (NEW.father_home_phone <=> OLD.father_home_phone) THEN
    INSERT INTO family_mirror_lock_log (child_id, table_name, col_name, attempted_value, kept_value, db_user)
    VALUES (OLD.child_id, 'children_additional_information', 'father_home_phone', NEW.father_home_phone, OLD.father_home_phone, v_db_user);
    SET NEW.father_home_phone = OLD.father_home_phone;
  END IF;
  IF NOT (NEW.father_email <=> OLD.father_email) THEN
    INSERT INTO family_mirror_lock_log (child_id, table_name, col_name, attempted_value, kept_value, db_user)
    VALUES (OLD.child_id, 'children_additional_information', 'father_email', NEW.father_email, OLD.father_email, v_db_user);
    SET NEW.father_email = OLD.father_email;
  END IF;
  IF NOT (NEW.father_address <=> OLD.father_address) THEN
    INSERT INTO family_mirror_lock_log (child_id, table_name, col_name, attempted_value, kept_value, db_user)
    VALUES (OLD.child_id, 'children_additional_information', 'father_address', NEW.father_address, OLD.father_address, v_db_user);
    SET NEW.father_address = OLD.father_address;
  END IF;
  IF NOT (NEW.father_occupation <=> OLD.father_occupation) THEN
    INSERT INTO family_mirror_lock_log (child_id, table_name, col_name, attempted_value, kept_value, db_user)
    VALUES (OLD.child_id, 'children_additional_information', 'father_occupation', NEW.father_occupation, OLD.father_occupation, v_db_user);
    SET NEW.father_occupation = OLD.father_occupation;
  END IF;
  IF NOT (NEW.father_employer <=> OLD.father_employer) THEN
    INSERT INTO family_mirror_lock_log (child_id, table_name, col_name, attempted_value, kept_value, db_user)
    VALUES (OLD.child_id, 'children_additional_information', 'father_employer', NEW.father_employer, OLD.father_employer, v_db_user);
    SET NEW.father_employer = OLD.father_employer;
  END IF;
  IF NOT (NEW.father_work_address <=> OLD.father_work_address) THEN
    INSERT INTO family_mirror_lock_log (child_id, table_name, col_name, attempted_value, kept_value, db_user)
    VALUES (OLD.child_id, 'children_additional_information', 'father_work_address', NEW.father_work_address, OLD.father_work_address, v_db_user);
    SET NEW.father_work_address = OLD.father_work_address;
  END IF;
  IF NOT (NEW.father_office_phone <=> OLD.father_office_phone) THEN
    INSERT INTO family_mirror_lock_log (child_id, table_name, col_name, attempted_value, kept_value, db_user)
    VALUES (OLD.child_id, 'children_additional_information', 'father_office_phone', NEW.father_office_phone, OLD.father_office_phone, v_db_user);
    SET NEW.father_office_phone = OLD.father_office_phone;
  END IF;
  IF NOT (NEW.mother_fname <=> OLD.mother_fname) THEN
    INSERT INTO family_mirror_lock_log (child_id, table_name, col_name, attempted_value, kept_value, db_user)
    VALUES (OLD.child_id, 'children_additional_information', 'mother_fname', NEW.mother_fname, OLD.mother_fname, v_db_user);
    SET NEW.mother_fname = OLD.mother_fname;
  END IF;
  IF NOT (NEW.mother_lname <=> OLD.mother_lname) THEN
    INSERT INTO family_mirror_lock_log (child_id, table_name, col_name, attempted_value, kept_value, db_user)
    VALUES (OLD.child_id, 'children_additional_information', 'mother_lname', NEW.mother_lname, OLD.mother_lname, v_db_user);
    SET NEW.mother_lname = OLD.mother_lname;
  END IF;
  IF NOT (NEW.mother_home_phone <=> OLD.mother_home_phone) THEN
    INSERT INTO family_mirror_lock_log (child_id, table_name, col_name, attempted_value, kept_value, db_user)
    VALUES (OLD.child_id, 'children_additional_information', 'mother_home_phone', NEW.mother_home_phone, OLD.mother_home_phone, v_db_user);
    SET NEW.mother_home_phone = OLD.mother_home_phone;
  END IF;
  IF NOT (NEW.mother_email <=> OLD.mother_email) THEN
    INSERT INTO family_mirror_lock_log (child_id, table_name, col_name, attempted_value, kept_value, db_user)
    VALUES (OLD.child_id, 'children_additional_information', 'mother_email', NEW.mother_email, OLD.mother_email, v_db_user);
    SET NEW.mother_email = OLD.mother_email;
  END IF;
  IF NOT (NEW.mother_address <=> OLD.mother_address) THEN
    INSERT INTO family_mirror_lock_log (child_id, table_name, col_name, attempted_value, kept_value, db_user)
    VALUES (OLD.child_id, 'children_additional_information', 'mother_address', NEW.mother_address, OLD.mother_address, v_db_user);
    SET NEW.mother_address = OLD.mother_address;
  END IF;
  IF NOT (NEW.mother_occupation <=> OLD.mother_occupation) THEN
    INSERT INTO family_mirror_lock_log (child_id, table_name, col_name, attempted_value, kept_value, db_user)
    VALUES (OLD.child_id, 'children_additional_information', 'mother_occupation', NEW.mother_occupation, OLD.mother_occupation, v_db_user);
    SET NEW.mother_occupation = OLD.mother_occupation;
  END IF;
  IF NOT (NEW.mother_employer <=> OLD.mother_employer) THEN
    INSERT INTO family_mirror_lock_log (child_id, table_name, col_name, attempted_value, kept_value, db_user)
    VALUES (OLD.child_id, 'children_additional_information', 'mother_employer', NEW.mother_employer, OLD.mother_employer, v_db_user);
    SET NEW.mother_employer = OLD.mother_employer;
  END IF;
  IF NOT (NEW.mother_work_address <=> OLD.mother_work_address) THEN
    INSERT INTO family_mirror_lock_log (child_id, table_name, col_name, attempted_value, kept_value, db_user)
    VALUES (OLD.child_id, 'children_additional_information', 'mother_work_address', NEW.mother_work_address, OLD.mother_work_address, v_db_user);
    SET NEW.mother_work_address = OLD.mother_work_address;
  END IF;
  IF NOT (NEW.mother_office_phone <=> OLD.mother_office_phone) THEN
    INSERT INTO family_mirror_lock_log (child_id, table_name, col_name, attempted_value, kept_value, db_user)
    VALUES (OLD.child_id, 'children_additional_information', 'mother_office_phone', NEW.mother_office_phone, OLD.mother_office_phone, v_db_user);
    SET NEW.mother_office_phone = OLD.mother_office_phone;
  END IF;
END//

DELIMITER ;
