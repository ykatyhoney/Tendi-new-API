-- Hand-made family fixtures for sp_family_preview (PLAN.md "Testing": mirror rule cases).
-- tendi_family_test only (CLAUDE.md rule 7: its cleanup sets children.family_id).
-- Re-runnable: deletes its own rows first (families named 'FIXTURE %',
-- people with note 'fixture:mirror-cases'). Never sets children.family_id; preview them with
-- CALL sp_family_preview(<child>, <family>).
--
-- Cases (one child each, the 1st..4th active children that have a children_additional_information row):
--   1. Both parents       father + mother; mother is payment-responsible
--   2. Step-father only   step_father + grandmother (primary member); nobody payment-responsible
--   3. No mother          father only (a trashed mother is ignored); father has no rights row
--                         and no primary phone
--   4. Two payers         father and mother both payment-responsible; mother has the lower
--                         sort_order; a step_father with sort_order 0 loses the father slot to the father

-- Unlink any child linked to a fixture family first (children.family_id restricts the delete).
UPDATE children SET family_id = NULL
 WHERE family_id IN (SELECT id FROM families WHERE name LIKE 'FIXTURE %');
DELETE fmc FROM family_member_children fmc
  JOIN family_members fm ON fm.id = fmc.member_id
  JOIN families f ON f.id = fm.family_id
 WHERE f.name LIKE 'FIXTURE %';
DELETE fm FROM family_members fm JOIN families f ON f.id = fm.family_id WHERE f.name LIKE 'FIXTURE %';
DELETE FROM people WHERE note = 'fixture:mirror-cases';
DELETE FROM families WHERE name LIKE 'FIXTURE %';

SET @c1 = (SELECT c.id FROM children c JOIN children_additional_information cai ON cai.child_id = c.id
            WHERE c.status = 'active' ORDER BY c.id LIMIT 1 OFFSET 0);
SET @c2 = (SELECT c.id FROM children c JOIN children_additional_information cai ON cai.child_id = c.id
            WHERE c.status = 'active' ORDER BY c.id LIMIT 1 OFFSET 1);
SET @c3 = (SELECT c.id FROM children c JOIN children_additional_information cai ON cai.child_id = c.id
            WHERE c.status = 'active' ORDER BY c.id LIMIT 1 OFFSET 2);
SET @c4 = (SELECT c.id FROM children c JOIN children_additional_information cai ON cai.child_id = c.id
            WHERE c.status = 'active' ORDER BY c.id LIMIT 1 OFFSET 3);

-- 1. Both parents --------------------------------------------------------------
INSERT INTO families (name, household_phone, created_at, updated_at, created_by, updated_by)
VALUES ('FIXTURE Both parents', '718-555-0101', NOW(), NOW(), 0, 0);
SET @f1 = LAST_INSERT_ID();

INSERT INTO people (fname, lname, legacy_full_name, email, occupation, employer, note, created_at, updated_at, created_by, updated_by)
VALUES ('Avraham', 'Testman', 'Avi Testman', 'avi.testman@example.test', 'Accountant', 'Acme Books',
        'fixture:mirror-cases', NOW(), NOW(), 0, 0);
SET @p1f = LAST_INSERT_ID();
INSERT INTO people_phones (person_id, phone, phone_normalized, label, channel, is_primary, sort_order) VALUES
  (@p1f, '(347) 555-0111', '3475550111', 'mobile', 'sms', 1, 0),
  (@p1f, '718-555-0112', '7185550112', 'home', 'voice', 0, 1),
  (@p1f, '212-555-0113', '2125550113', 'work', 'none', 0, 2);
INSERT INTO people_addresses (person_id, kind, line1, line2, city, state, zip) VALUES
  (@p1f, 'home', '12 Fixture St', 'Apt 4B', 'Brooklyn', 'NY', '11211'),
  (@p1f, 'work', '1 Office Plaza', '', 'New York', 'NY', '10001');

INSERT INTO people (fname, lname, legacy_full_name, email, note, created_at, updated_at, created_by, updated_by)
VALUES ('Sara', 'Testman', '', 'sara.testman@example.test', 'fixture:mirror-cases', NOW(), NOW(), 0, 0);
SET @p1m = LAST_INSERT_ID();
INSERT INTO people_phones (person_id, phone, phone_normalized, label, channel, is_primary, sort_order) VALUES
  (@p1m, '347-555-0121', '3475550121', 'mobile', 'sms', 1, 0);
INSERT INTO people_addresses (person_id, kind, line1, line2, city, state, zip) VALUES
  (@p1m, 'home', '12 Fixture St', '', 'Brooklyn', 'NY', '');

INSERT INTO family_members (family_id, person_id, relationship, is_primary, sort_order) VALUES (@f1, @p1f, 'father', 1, 0);
SET @m1f = LAST_INSERT_ID();
INSERT INTO family_members (family_id, person_id, relationship, is_primary, sort_order) VALUES (@f1, @p1m, 'mother', 0, 1);
SET @m1m = LAST_INSERT_ID();
INSERT INTO family_member_children (member_id, child_id, is_primary, receives_notifications, notify_method, may_collect, is_payment_responsible) VALUES
  (@m1f, @c1, 1, 1, 'sms', 1, 0),
  (@m1m, @c1, 0, 0, 'voice', 1, 1);

-- 2. Step-father only ----------------------------------------------------------
INSERT INTO families (name, household_phone, created_at, updated_at, created_by, updated_by)
VALUES ('FIXTURE Step-father only', '', NOW(), NOW(), 0, 0);
SET @f2 = LAST_INSERT_ID();

INSERT INTO people (fname, lname, legacy_full_name, email, note, created_at, updated_at, created_by, updated_by)
VALUES ('Moshe', 'Stepman', '', 'moshe.stepman@example.test', 'fixture:mirror-cases', NOW(), NOW(), 0, 0);
SET @p2s = LAST_INSERT_ID();
INSERT INTO people_phones (person_id, phone, phone_normalized, label, channel, is_primary, sort_order) VALUES
  (@p2s, '917-555-0201', '9175550201', 'mobile', 'both', 1, 0);

INSERT INTO people (fname, lname, legacy_full_name, email, note, created_at, updated_at, created_by, updated_by)
VALUES ('Rivka', 'Grand', '', 'rivka.grand@example.test', 'fixture:mirror-cases', NOW(), NOW(), 0, 0);
SET @p2g = LAST_INSERT_ID();

INSERT INTO family_members (family_id, person_id, relationship, is_primary, sort_order) VALUES (@f2, @p2s, 'step_father', 0, 1);
SET @m2s = LAST_INSERT_ID();
INSERT INTO family_members (family_id, person_id, relationship, is_primary, sort_order) VALUES (@f2, @p2g, 'grandmother', 1, 0);
SET @m2g = LAST_INSERT_ID();
INSERT INTO family_member_children (member_id, child_id, is_primary, receives_notifications, notify_method, may_collect, is_payment_responsible) VALUES
  (@m2s, @c2, 1, 1, 'both', 1, 0),
  (@m2g, @c2, 0, 0, 'sms', 1, 0);

-- 3. No mother -----------------------------------------------------------------
INSERT INTO families (name, household_phone, created_at, updated_at, created_by, updated_by)
VALUES ('FIXTURE No mother', '845-555-0301', NOW(), NOW(), 0, 0);
SET @f3 = LAST_INSERT_ID();

INSERT INTO people (fname, lname, legacy_full_name, email, note, created_at, updated_at, created_by, updated_by)
VALUES ('Yosef', 'Solo', 'Yossi Solo', 'yossi.solo@example.test', 'fixture:mirror-cases', NOW(), NOW(), 0, 0);
SET @p3f = LAST_INSERT_ID();
INSERT INTO people_phones (person_id, phone, phone_normalized, label, channel, is_primary, sort_order) VALUES
  (@p3f, '845-555-0311', '8455550311', 'mobile', 'sms', 0, 0);

INSERT INTO people (fname, lname, legacy_full_name, email, note, created_at, updated_at, created_by, updated_by)
VALUES ('Leah', 'Solo', '', 'leah.solo@example.test', 'fixture:mirror-cases', NOW(), NOW(), 0, 0);
SET @p3m = LAST_INSERT_ID();

INSERT INTO family_members (family_id, person_id, relationship, is_primary, sort_order) VALUES (@f3, @p3f, 'father', 1, 0);
INSERT INTO family_members (family_id, person_id, relationship, is_primary, sort_order, status) VALUES (@f3, @p3m, 'mother', 0, 1, 'trash');
SET @m3m = LAST_INSERT_ID();
INSERT INTO family_member_children (member_id, child_id, is_primary, receives_notifications, notify_method, may_collect, is_payment_responsible) VALUES
  (@m3m, @c3, 0, 1, 'sms', 1, 1);

-- 4. Two payment-responsible members -------------------------------------------
INSERT INTO families (name, household_phone, created_at, updated_at, created_by, updated_by)
VALUES ('FIXTURE Two payers', '718-555-0401', NOW(), NOW(), 0, 0);
SET @f4 = LAST_INSERT_ID();

INSERT INTO people (fname, lname, legacy_full_name, email, note, created_at, updated_at, created_by, updated_by)
VALUES ('Dovid', 'Payer', 'Dovid Payer', 'dovid.payer@example.test', 'fixture:mirror-cases', NOW(), NOW(), 0, 0);
SET @p4f = LAST_INSERT_ID();
INSERT INTO people_phones (person_id, phone, phone_normalized, label, channel, is_primary, sort_order) VALUES
  (@p4f, '718-555-0411', '7185550411', 'mobile', 'sms', 1, 0);

INSERT INTO people (fname, lname, legacy_full_name, email, note, created_at, updated_at, created_by, updated_by)
VALUES ('Chana', 'Payer', 'Chana Payer', 'chana.payer@example.test', 'fixture:mirror-cases', NOW(), NOW(), 0, 0);
SET @p4m = LAST_INSERT_ID();
INSERT INTO people_phones (person_id, phone, phone_normalized, label, channel, is_primary, sort_order) VALUES
  (@p4m, '718-555-0421', '7185550421', 'mobile', 'voice', 1, 0),
  (@p4m, '718-555-0422', '7185550422', 'home', 'none', 0, 1);

INSERT INTO people (fname, lname, legacy_full_name, email, note, created_at, updated_at, created_by, updated_by)
VALUES ('Extra', 'Step', '', 'extra.step@example.test', 'fixture:mirror-cases', NOW(), NOW(), 0, 0);
SET @p4s = LAST_INSERT_ID();

INSERT INTO family_members (family_id, person_id, relationship, is_primary, sort_order) VALUES (@f4, @p4f, 'father', 1, 1);
SET @m4f = LAST_INSERT_ID();
INSERT INTO family_members (family_id, person_id, relationship, is_primary, sort_order) VALUES (@f4, @p4m, 'mother', 0, 0);
SET @m4m = LAST_INSERT_ID();
INSERT INTO family_members (family_id, person_id, relationship, is_primary, sort_order) VALUES (@f4, @p4s, 'step_father', 0, 0);
INSERT INTO family_member_children (member_id, child_id, is_primary, receives_notifications, notify_method, may_collect, is_payment_responsible) VALUES
  (@m4f, @c4, 1, 1, 'sms', 1, 1),
  (@m4m, @c4, 0, 1, 'voice', 1, 1);

SELECT @c1 AS child_1, @f1 AS family_1, @c2 AS child_2, @f2 AS family_2,
       @c3 AS child_3, @f3 AS family_3, @c4 AS child_4, @f4 AS family_4;
