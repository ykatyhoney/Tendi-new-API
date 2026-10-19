-- Family module: re-mirrors every family a person belongs to (any membership status, so a
-- person or membership moving to trash also re-mirrors). Used by the people, people_phones and
-- people_addresses triggers. Runs inside the caller's transaction.
DELIMITER //
CREATE PROCEDURE sp_family_mirror_person(IN p_person_id INT)
MODIFIES SQL DATA
SQL SECURITY INVOKER
COMMENT 'Family mirror: calls sp_family_mirror_family for every family of one person'
body: BEGIN
  DECLARE v_family_id INT;

  IF p_person_id IS NULL THEN
    LEAVE body;
  END IF;

  SET v_family_id = (SELECT MIN(family_id) FROM family_members WHERE person_id = p_person_id);
  WHILE v_family_id IS NOT NULL DO
    CALL sp_family_mirror_family(v_family_id);
    SET v_family_id = (SELECT MIN(family_id) FROM family_members
                        WHERE person_id = p_person_id AND family_id > v_family_id);
  END WHILE;
END//
DELIMITER ;
