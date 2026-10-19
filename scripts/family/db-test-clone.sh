#!/usr/bin/env bash
# Drops and recreates the local family test database (DB_TEST_NAME, default
# tendi_family_test) as a copy of DB_NAME (default tendi_family_dev), including
# triggers and routines, then runs the same checks as the restore.
#
# Usage: npm run db:family:test-clone
# Run npm run db:family:restore first.

source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

load_env
[[ "$DB_NAME" != "$DB_TEST_NAME" ]] || die "DB_NAME and DB_TEST_NAME are both $DB_NAME"

init_client
check_server

database_exists "$DB_NAME" || die "$DB_NAME does not exist; run npm run db:family:restore first"

read -r charset collation < <(
  dbq "SELECT DEFAULT_CHARACTER_SET_NAME, DEFAULT_COLLATION_NAME
       FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = '$DB_NAME'"
)
[[ "${charset:-}" =~ ^[a-z0-9_]+$ && "${collation:-}" =~ ^[a-z0-9_]+$ ]] \
  || die "could not read the character set of $DB_NAME"

echo "Recreating $DB_TEST_NAME ($charset / $collation)"
dbq "DROP DATABASE IF EXISTS \`$DB_TEST_NAME\`;
     CREATE DATABASE \`$DB_TEST_NAME\` CHARACTER SET $charset COLLATE $collation;"

echo "Copying $DB_NAME into $DB_TEST_NAME"
started=$SECONDS
mysqldump_local --single-transaction --routines --triggers --hex-blob "$DB_NAME" \
  | db "$DB_TEST_NAME"
echo "Copied in $((SECONDS - started))s"

verify_database "$DB_TEST_NAME"
