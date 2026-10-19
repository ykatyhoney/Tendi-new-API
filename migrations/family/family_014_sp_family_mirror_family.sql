-- Family module: re-mirrors every child linked to one family (children.family_id = p_family_id).
-- Walks the children by id instead of a cursor, so a NOT FOUND condition raised deeper in the
-- call chain cannot end the loop early. Runs inside the caller's transaction.
DELIMITER //
CREATE PROCEDURE sp_family_mirror_family(IN p_family_id INT)
MODIFIES SQL DATA
SQL SECURITY INVOKER
COMMENT 'Family mirror: calls sp_family_mirror for every child linked to one family'
body: BEGIN
  DECLARE v_child_id INT;

  IF p_family_id IS NULL THEN
    LEAVE body;
  END IF;

  SET v_child_id = (SELECT MIN(id) FROM children WHERE family_id = p_family_id);
  WHILE v_child_id IS NOT NULL DO
    CALL sp_family_mirror(v_child_id);
    SET v_child_id = (SELECT MIN(id) FROM children WHERE family_id = p_family_id AND id > v_child_id);
  END WHILE;
END//
DELIMITER ;
