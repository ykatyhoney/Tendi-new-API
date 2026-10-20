-- Privileges of family_api, the database user the Family API connects as (PLAN.md "Security,
-- permissions and audit"). Nothing else is granted.
--
-- Applied to one database at a time (table names are unqualified, so they refer to the database
-- the file runs in) by scripts/family/apply-grants.sh (npm run db:family:grants). That script
-- first creates the account 'family_api'@'localhost' with the password FAMILY_DB_PASSWORD from
-- .env (never stored in this file) and revokes every earlier privilege, so the result is exactly
-- this list. Production gets the same grants from the deployment runbook, with its own host part.
--
-- DEFINER rule: the mirror is what writes the 28 legacy parent columns, never family_api.
--   * The family triggers and the writing procedures (sp_family_mirror, sp_family_mirror_cai) run
--     with the privileges of their DEFINER. The migrations set no explicit DEFINER, so the definer
--     is the user that runs the migrations (CURRENT_USER). That user must be able to UPDATE the
--     legacy columns of children / children_additional_information, INSERT into
--     children_additional_information, family_mirror_lock_log and record_audit (the ra_* audit
--     triggers fire on the mirror's writes), and read the family tables.
--   * Checked 2026-10-19: every family trigger and procedure has definer root@localhost locally.
--     sp_family_mirror and sp_family_mirror_cai are SQL SECURITY DEFINER. sp_family_preview is
--     SQL SECURITY DEFINER since migration family_024, so family_api needs EXECUTE on it alone,
--     not on the procedures it calls. The other procedures are SQL SECURITY INVOKER and are only
--     ever called from the triggers or from DEFINER procedures, i.e. as the definer.
--   * So family_api never needs, and does not get, UPDATE on any legacy column: a direct
--     UPDATE children SET father_phone = ... fails with "UPDATE command denied ... for column".

-- Reads
GRANT SELECT ON families                        TO 'family_api'@'localhost';
GRANT SELECT ON people                          TO 'family_api'@'localhost';
GRANT SELECT ON family_members                  TO 'family_api'@'localhost';
GRANT SELECT ON people_phones                   TO 'family_api'@'localhost';
GRANT SELECT ON people_addresses                TO 'family_api'@'localhost';
GRANT SELECT ON family_member_children          TO 'family_api'@'localhost';
GRANT SELECT ON children                        TO 'family_api'@'localhost';
GRANT SELECT ON children_additional_information TO 'family_api'@'localhost';
GRANT SELECT ON admin                           TO 'family_api'@'localhost';
GRANT SELECT ON admin_api_tokens                TO 'family_api'@'localhost';

-- Writes to the 6 family tables (the triggers on them run as their definer and do the mirroring)
GRANT INSERT, UPDATE, DELETE ON families               TO 'family_api'@'localhost';
GRANT INSERT, UPDATE, DELETE ON people                 TO 'family_api'@'localhost';
GRANT INSERT, UPDATE, DELETE ON family_members         TO 'family_api'@'localhost';
GRANT INSERT, UPDATE, DELETE ON people_phones          TO 'family_api'@'localhost';
GRANT INSERT, UPDATE, DELETE ON people_addresses       TO 'family_api'@'localhost';
GRANT INSERT, UPDATE, DELETE ON family_member_children TO 'family_api'@'localhost';

-- Link and unlink: the one children column the API may write
GRANT UPDATE (family_id) ON children TO 'family_api'@'localhost';

-- The audit_logs row every family write adds (backend CLAUDE.md rule 5)
GRANT INSERT ON audit_logs TO 'family_api'@'localhost';

-- The link preview (GET /families/:id/children/:childId/preview)
GRANT EXECUTE ON PROCEDURE sp_family_preview TO 'family_api'@'localhost';
