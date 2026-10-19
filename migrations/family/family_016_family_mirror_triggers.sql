-- Family module, SCHEMA.md "Database objects: mirror and lock": after-write triggers on the
-- family tables that re-mirror the affected linked children. They only write children and
-- children_additional_information (through sp_family_mirror), never the table that fired them.
-- Deletes use OLD; updates use NEW and also OLD when the key column changed.
-- Several statements in one migration: CREATE OR REPLACE here and DROP ... IF EXISTS in the
-- down step make a partly applied run safe to re-run.
DELIMITER //

CREATE OR REPLACE TRIGGER trg_families_au AFTER UPDATE ON families FOR EACH ROW
  CALL sp_family_mirror_family(NEW.id)//

CREATE OR REPLACE TRIGGER trg_family_members_ai AFTER INSERT ON family_members FOR EACH ROW
  CALL sp_family_mirror_family(NEW.family_id)//

CREATE OR REPLACE TRIGGER trg_family_members_au AFTER UPDATE ON family_members FOR EACH ROW
BEGIN
  CALL sp_family_mirror_family(NEW.family_id);
  IF NOT (OLD.family_id <=> NEW.family_id) THEN
    CALL sp_family_mirror_family(OLD.family_id);
  END IF;
END//

CREATE OR REPLACE TRIGGER trg_family_members_ad AFTER DELETE ON family_members FOR EACH ROW
  CALL sp_family_mirror_family(OLD.family_id)//

CREATE OR REPLACE TRIGGER trg_people_au AFTER UPDATE ON people FOR EACH ROW
  CALL sp_family_mirror_person(NEW.id)//

CREATE OR REPLACE TRIGGER trg_people_phones_ai AFTER INSERT ON people_phones FOR EACH ROW
  CALL sp_family_mirror_person(NEW.person_id)//

CREATE OR REPLACE TRIGGER trg_people_phones_au AFTER UPDATE ON people_phones FOR EACH ROW
BEGIN
  CALL sp_family_mirror_person(NEW.person_id);
  IF NOT (OLD.person_id <=> NEW.person_id) THEN
    CALL sp_family_mirror_person(OLD.person_id);
  END IF;
END//

CREATE OR REPLACE TRIGGER trg_people_phones_ad AFTER DELETE ON people_phones FOR EACH ROW
  CALL sp_family_mirror_person(OLD.person_id)//

CREATE OR REPLACE TRIGGER trg_people_addresses_ai AFTER INSERT ON people_addresses FOR EACH ROW
  CALL sp_family_mirror_person(NEW.person_id)//

CREATE OR REPLACE TRIGGER trg_people_addresses_au AFTER UPDATE ON people_addresses FOR EACH ROW
BEGIN
  CALL sp_family_mirror_person(NEW.person_id);
  IF NOT (OLD.person_id <=> NEW.person_id) THEN
    CALL sp_family_mirror_person(OLD.person_id);
  END IF;
END//

CREATE OR REPLACE TRIGGER trg_people_addresses_ad AFTER DELETE ON people_addresses FOR EACH ROW
  CALL sp_family_mirror_person(OLD.person_id)//

CREATE OR REPLACE TRIGGER trg_fmc_ai AFTER INSERT ON family_member_children FOR EACH ROW
  CALL sp_family_mirror(NEW.child_id)//

CREATE OR REPLACE TRIGGER trg_fmc_au AFTER UPDATE ON family_member_children FOR EACH ROW
BEGIN
  CALL sp_family_mirror(NEW.child_id);
  IF NOT (OLD.child_id <=> NEW.child_id) THEN
    CALL sp_family_mirror(OLD.child_id);
  END IF;
END//

CREATE OR REPLACE TRIGGER trg_fmc_ad AFTER DELETE ON family_member_children FOR EACH ROW
  CALL sp_family_mirror(OLD.child_id)//

DELIMITER ;
