#!/usr/bin/env bash
# Drops and recreates the local family development database (DB_NAME, default
# tendi_family_dev) and loads the 2026-09-24 dump into it, then verifies tables,
# row counts and the ra_* audit triggers.
#
# Usage: npm run db:family:restore [-- <path to dump.sql>]
# The dump path defaults to FAMILY_DUMP_PATH in .env.
#
# The dump has no DEFINER clauses and no routines, so its 312 ra_* triggers are
# created with DB_USER as their definer; no definer users need to exist locally.

source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

load_env

dump="${1:-${FAMILY_DUMP_PATH:-}}"
[[ -n "$dump" ]] || die "no dump given: pass a path or set FAMILY_DUMP_PATH in .env"
dump="$(shell_path "$dump")"
[[ -f "$dump" ]] || die "dump not found: $dump"
head -c 200 "$dump" | grep -q '^-- MariaDB dump' || die "$dump does not look like a MariaDB dump"

init_client
check_server

echo "Recreating $DB_NAME on $DB_HOST:$DB_PORT"
dbq "DROP DATABASE IF EXISTS \`$DB_NAME\`;
     CREATE DATABASE \`$DB_NAME\` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;"

echo "Loading $dump"
started=$SECONDS
db "$DB_NAME" < "$dump"
echo "Loaded in $((SECONDS - started))s"

verify_database "$DB_NAME"
