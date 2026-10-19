-- Down step for the migration with the same name. Down runs in reverse order of up.
DROP TRIGGER IF EXISTS trg_cai_family_bu;
DROP TRIGGER IF EXISTS trg_children_family_au;
DROP TRIGGER IF EXISTS trg_children_family_bu;
