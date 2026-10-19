#!/usr/bin/env bash
# Creates the local family_api account and applies scripts/family/grants.sql to the local family
# databases (DB_NAME and DB_TEST_NAME; one that does not exist yet is skipped).
#
# Usage: npm run db:family:grants
#
# The password is FAMILY_DB_PASSWORD from .env, sent through the temporary option file like every
# other credential here. Every earlier privilege of the account is revoked first, so after a run
# it holds exactly what grants.sql lists, in each database.

source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

load_env
init_client
check_server

[[ "${FAMILY_DB_USER:-}" == family_api ]] || die "FAMILY_DB_USER must be family_api (grants.sql names that account)"
[[ -n "${FAMILY_DB_PASSWORD:-}" ]] || die "FAMILY_DB_PASSWORD is not set in .env"

sql_str() { local s="${1//\\/\\\\}"; printf "'%s'" "${s//\'/\'\'}"; }
password="$(sql_str "$FAMILY_DB_PASSWORD")"

echo "Account 'family_api'@'localhost': create if missing, set password, revoke all privileges"
dbq "CREATE USER IF NOT EXISTS 'family_api'@'localhost' IDENTIFIED BY $password;
     ALTER USER 'family_api'@'localhost' IDENTIFIED BY $password;
     REVOKE ALL PRIVILEGES, GRANT OPTION FROM 'family_api'@'localhost';"

for database in "$DB_NAME" "$DB_TEST_NAME"; do
  if ! database_exists "$database"; then
    echo "  $database: does not exist, skipped"
    continue
  fi
  db "$database" < "$FAMILY_SCRIPTS_DIR/grants.sql"
  echo "  $database: grants.sql applied"
done

echo
dbq "SHOW GRANTS FOR 'family_api'@'localhost'" | sed 's/^/  /'
