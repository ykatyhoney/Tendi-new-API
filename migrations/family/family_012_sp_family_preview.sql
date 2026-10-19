-- Family module: one row with the 29 legacy parent values for one child, named after the
-- legacy columns and typed like them. Writes nothing. Used by the API preview
-- (GET /families/:id/children/:childId/preview) and the proof run.
DELIMITER //
CREATE PROCEDURE sp_family_preview(
  IN p_child_id  INT,
  IN p_family_id INT  -- NULL = children.family_id; pass a family to preview an unlinked child
)
READS SQL DATA
SQL SECURITY INVOKER
COMMENT 'Family mirror: the 29 legacy parent values for one child as one row (read-only)'
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

  CALL sp_family_mirror_values(p_child_id, p_family_id,
    v_father_name, v_mother_name, v_father_phone, v_mother_phone, v_home_phone, v_parent_email,
    v_use_father_phone_for_notification, v_use_mother_phone_for_notification,
    v_notification_father_phone_method, v_notification_mother_phone_method, v_home_send_notification,
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
    v_home_send_notification            AS home_send_notification,
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
DELIMITER ;
