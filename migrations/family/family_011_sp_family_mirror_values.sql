-- Family module, PLAN.md "Legacy column mapping": the 29 legacy parent values for one child,
-- computed from the family tables without writing anything. Used by sp_family_preview and,
-- later, by the mirror and trg_children_family_bu (which passes NEW.family_id).
-- OUT types match the target columns exactly (SHOW COLUMNS on children and
-- children_additional_information, utf8mb4_general_ci).
--
-- Rules: only status = 'active' families, members and people count.
-- Father = member with relationship 'father', else 'step_father'; mother likewise with
-- 'mother' / 'step_mother'; ties go to the lowest sort_order, then the lowest id.
DELIMITER //
CREATE PROCEDURE sp_family_mirror_values(
  IN  p_child_id                          INT,
  IN  p_family_id                         INT,  -- NULL = children.family_id (preview of an unlinked child passes a family)
  -- children (11)
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
  OUT o_home_send_notification            BIT(1),
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
COMMENT 'Family mirror: the 29 legacy parent values for one child (read-only)'
BEGIN
  DECLARE v_family_id       INT;
  DECLARE v_household_phone VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  DECLARE v_father_member   INT;
  DECLARE v_mother_member   INT;
  DECLARE v_msg             VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;

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

  -- TODO(step 2.2 proof run): home_send_notification has no confirmed rule yet (PLAN.md:
  -- "Derived from the household's notification settings (rule to confirm in the proof run)").
  -- Until then the child's currently stored value is kept unchanged.
  SET o_home_send_notification = (SELECT home_send_notification FROM children WHERE id = p_child_id);
END//
DELIMITER ;
