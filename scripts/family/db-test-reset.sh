#!/usr/bin/env bash
# Rebuilds the test database (DB_TEST_NAME, default tendi_family_test) from scratch: restores
# the 2026-09-24 dump into it and applies every family migration. Used before the database
# test suite, so tests never see state left in the development database.
#
# Usage: npm run db:family:test-reset

source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

load_env
[[ "$DB_NAME" != "$DB_TEST_NAME" ]] || die "DB_NAME and DB_TEST_NAME are both $DB_NAME"

DB_NAME="$DB_TEST_NAME" bash "$FAMILY_SCRIPTS_DIR/db-restore.sh"
echo
DB_NAME="$DB_TEST_NAME" bash "$FAMILY_SCRIPTS_DIR/migrate.sh" up
