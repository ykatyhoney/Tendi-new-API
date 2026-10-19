-- Family module: writes the 18 children_additional_information parent columns of one child
-- from the family tables (creating the row if missing, decision D4), with @family_mirror = 1
-- so trg_cai_family_bu lets the writes through. Reset to NULL at the end and on any error.
-- Called by trg_children_family_au when a child is linked: that trigger fires on children, so it
-- cannot use sp_family_mirror (which also updates children). Runs in the caller's transaction.
DELIMITER //
CREATE PROCEDURE sp_family_mirror_cai(IN p_child_id INT, IN p_family_id INT)
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

  IF p_family_id IS NULL THEN
    LEAVE body;
  END IF;

  CALL sp_family_mirror_values(p_child_id, p_family_id,
    v_father_name, v_mother_name, v_father_phone, v_mother_phone, v_home_phone, v_parent_email,
    v_use_father_phone_for_notification, v_use_mother_phone_for_notification,
    v_notification_father_phone_method, v_notification_mother_phone_method,
    v_home_send_notification, v_father_fname, v_father_lname, v_father_home_phone, v_father_email,
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
DELIMITER ;
