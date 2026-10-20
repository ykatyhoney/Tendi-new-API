-- Family module: sp_family_preview runs with its definer's privileges (it reads only), so the
-- Family API's database user needs EXECUTE on sp_family_preview alone (scripts/family/grants.sql)
-- and not on sp_family_mirror_values / sp_family_parent_values, which it calls. As INVOKER, a
-- call by family_api failed with "execute command denied ... sp_family_mirror_values".
ALTER PROCEDURE sp_family_preview SQL SECURITY DEFINER;
