-- Down step for the migration with the same name. Down runs in reverse order of up.
DROP TRIGGER IF EXISTS trg_fmc_ad;
DROP TRIGGER IF EXISTS trg_fmc_au;
DROP TRIGGER IF EXISTS trg_fmc_ai;
DROP TRIGGER IF EXISTS trg_people_addresses_ad;
DROP TRIGGER IF EXISTS trg_people_addresses_au;
DROP TRIGGER IF EXISTS trg_people_addresses_ai;
DROP TRIGGER IF EXISTS trg_people_phones_ad;
DROP TRIGGER IF EXISTS trg_people_phones_au;
DROP TRIGGER IF EXISTS trg_people_phones_ai;
DROP TRIGGER IF EXISTS trg_people_au;
DROP TRIGGER IF EXISTS trg_family_members_ad;
DROP TRIGGER IF EXISTS trg_family_members_au;
DROP TRIGGER IF EXISTS trg_family_members_ai;
DROP TRIGGER IF EXISTS trg_families_au;
