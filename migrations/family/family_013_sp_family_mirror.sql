-- Family module, PLAN.md "Mirror and lock behavior": writes the 29 legacy parent columns of
-- one linked child from the family tables. Does nothing for an unlinked child.
-- Runs inside the caller's transaction (no COMMIT). SQL SECURITY DEFINER because it writes
-- legacy columns that the Family API's database user may not write itself.
-- @family_mirror = 1 while it writes, so the lock triggers (step 1.5) let these writes through;
-- it is reset to NULL at the end and on any error.
-- Writes only the 29 columns (children.updated_* are left alone; record_audit takes the actor
-- from @audit_user). A missing children_additional_information row is created (decision D4).
DELIMITER //
CREATE PROCEDURE sp_family_mirror(IN p_child_id INT)
MODIFIES SQL DATA
SQL SECURITY DEFINER
COMMENT 'Family mirror: writes the 29 legacy parent columns of one linked child'
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
    v_notification_father_phone_method, v_notification_mother_phone_method, v_home_send_notification,
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
    notification_mother_phone_method  = v_notification_mother_phone_method,
    home_send_notification            = v_home_send_notification
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
DELIMITER ;
