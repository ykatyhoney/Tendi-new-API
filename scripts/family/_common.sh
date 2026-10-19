# Shared helpers for the family-module database scripts. Sourced, not run.
#
# - Loads Tendi-new-API/.env (variables already set in the environment win).
# - Refuses any host other than localhost / 127.0.0.1 / ::1, any database not
#   named tendi_family_*, and any server whose @@hostname is not this machine
#   (catches a local port that is really a tunnel to another server).
# - Passes credentials to the mysql CLI through a temporary option file, never argv.

set -euo pipefail

FAMILY_SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_ROOT="$(cd "$FAMILY_SCRIPTS_DIR/../.." && pwd)"

# Expected contents of the 2026-09-24 dump (counted from the dump file itself).
EXPECTED_BASE_TABLES=209
EXPECTED_VIEWS=2
EXPECTED_CHILDREN=753
EXPECTED_CAI=749
EXPECTED_RA_TRIGGERS=312
EXPECTED_RA_TRIGGER_TABLES=104
EXPECTED_ROUTINES=0

# Tables added by migrations/family; counted apart from the dump's 209.
FAMILY_TABLES="'families','people','family_members','people_phones','people_addresses','family_member_children','family_mirror_lock_log','family_backfill_runs','family_backfill_rows','family_backfill_child_map','family_reconcile_runs'"

PRODUCTION_VERSION="10.11.9"

die() { echo "error: $*" >&2; exit 1; }
warn() { echo "warning: $*" >&2; }

# Converts a path for the Windows mysql.exe when running under Git Bash.
native_path() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s\n' "$1"; fi
}

# Converts a path from .env (which may use C:\ or C:/) for bash.
shell_path() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -u "$1"; else printf '%s\n' "$1"; fi
}

load_env() {
  local file="$API_ROOT/.env" line key value
  [[ -f "$file" ]] || die "missing $file (copy .env.example to .env and fill it in)"
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
    [[ "$line" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=(.*)$ ]] || continue
    key="${BASH_REMATCH[1]}"
    value="${BASH_REMATCH[2]}"
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    if [[ "$value" =~ ^\"(.*)\"$ || "$value" =~ ^\'(.*)\'$ ]]; then
      value="${BASH_REMATCH[1]}"
    fi
    if [[ -z "${!key+x}" ]]; then export "$key=$value"; fi
  done < "$file"

  : "${DB_HOST:?DB_HOST is not set in .env}"
  : "${DB_PORT:?DB_PORT is not set in .env}"
  : "${DB_USER:?DB_USER is not set in .env}"
  : "${DB_NAME:?DB_NAME is not set in .env}"
  : "${DB_TEST_NAME:?DB_TEST_NAME is not set in .env}"
  DB_PASSWORD="${DB_PASSWORD:-}"

  case "${DB_HOST,,}" in
    localhost|127.0.0.1|::1) ;;
    *) die "DB_HOST=$DB_HOST is not a local host; these scripts only run against the local MariaDB" ;;
  esac
  require_family_db_name "$DB_NAME"
  require_family_db_name "$DB_TEST_NAME"
}

require_family_db_name() {
  [[ "$1" =~ ^tendi_family_[a-z0-9_]+$ ]] \
    || die "refusing to use database '$1': the name must match tendi_family_[a-z0-9_]+"
}

find_client() {
  local name="$1" dir
  if [[ -n "${MARIADB_BIN_DIR:-}" ]]; then
    dir="$(shell_path "$MARIADB_BIN_DIR")"
    for candidate in "$dir/$name" "$dir/$name.exe"; do
      [[ -x "$candidate" ]] && { printf '%s\n' "$candidate"; return; }
    done
    die "$name not found in MARIADB_BIN_DIR=$MARIADB_BIN_DIR"
  fi
  if command -v "$name" >/dev/null 2>&1; then command -v "$name"; return; fi
  for dir in "/c/Program Files/MariaDB 10.11/bin" "/c/Program Files/MariaDB"*/bin; do
    [[ -x "$dir/$name.exe" ]] && { printf '%s\n' "$dir/$name.exe"; return; }
  done
  die "$name not found on PATH or under C:\\Program Files\\MariaDB*; install MariaDB 10.11 or set MARIADB_BIN_DIR in .env"
}

# Writes the [client] option file and sets MYSQL / MYSQLDUMP / OPT_FILE.
init_client() {
  MYSQL="$(find_client mysql)"
  MYSQLDUMP="$(find_client mysqldump)"

  local escaped_password
  OPT_FILE_TMP="$(mktemp)"
  trap 'rm -f "$OPT_FILE_TMP"' EXIT
  chmod 600 "$OPT_FILE_TMP"
  escaped_password="${DB_PASSWORD//\\/\\\\}"
  escaped_password="${escaped_password//\"/\\\"}"
  printf '[client]\nhost=%s\nport=%s\nuser=%s\npassword="%s"\n' \
    "$DB_HOST" "$DB_PORT" "$DB_USER" "$escaped_password" > "$OPT_FILE_TMP"
  OPT_FILE="$(native_path "$OPT_FILE_TMP")"
}

# mysql with the local credentials; extra arguments are passed through.
db() { "$MYSQL" --defaults-extra-file="$OPT_FILE" --default-character-set=utf8mb4 "$@"; }

# One query, tab-separated, no headers.
dbq() { db --batch --skip-column-names -e "$1" "${@:2}"; }

mysqldump_local() { "$MYSQLDUMP" --defaults-extra-file="$OPT_FILE" --default-character-set=utf8mb4 "$@"; }

# Confirms the server is MariaDB on this machine and reports its version.
check_server() {
  local server_host local_host version
  server_host="$(dbq 'SELECT @@hostname')" \
    || die "cannot connect to MariaDB at $DB_HOST:$DB_PORT as $DB_USER (is the service running? is DB_PASSWORD right?)"
  local_host="$(hostname)"
  if [[ "${server_host,,}" != "${local_host,,}" ]]; then
    die "the server at $DB_HOST:$DB_PORT reports hostname '$server_host', but this machine is '$local_host'; refusing to continue (a tunnel to another server?)"
  fi

  version="$(dbq 'SELECT VERSION()')"
  echo "MariaDB server: $version on $server_host (production: $PRODUCTION_VERSION)"
  case "$version" in
    "$PRODUCTION_VERSION"-*MariaDB*) ;;
    10.11.*MariaDB*) warn "local MariaDB is ${version%%-*}, production is $PRODUCTION_VERSION (same 10.11 series)" ;;
    *MariaDB*) warn "local MariaDB is ${version%%-*}, not 10.11.x; production is $PRODUCTION_VERSION" ;;
    *) warn "the server is not MariaDB ($version); production is MariaDB $PRODUCTION_VERSION" ;;
  esac
}

database_exists() {
  [[ "$(dbq "SELECT COUNT(*) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = '$1'")" == 1 ]]
}

# Prints the restore checks for one database and exits non-zero on any mismatch.
verify_database() {
  local db_name="$1" failures=0
  local base_tables family_tables views children cai routines other_triggers family_triggers ra_triggers ra_trigger_tables

  base_tables="$(dbq "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = '$db_name' AND TABLE_TYPE = 'BASE TABLE' AND TABLE_NAME NOT IN ($FAMILY_TABLES)")"
  family_tables="$(dbq "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = '$db_name' AND TABLE_NAME IN ($FAMILY_TABLES)")"
  views="$(dbq "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = '$db_name' AND TABLE_TYPE = 'VIEW'")"
  children="$(dbq "SELECT COUNT(*) FROM \`$db_name\`.children")"
  cai="$(dbq "SELECT COUNT(*) FROM \`$db_name\`.children_additional_information")"
  routines="$(dbq "SELECT COUNT(*) FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = '$db_name' AND ROUTINE_NAME NOT LIKE 'sp\_family\_%'")"

  # SHOW TRIGGERS: column 1 = trigger name, column 3 = table. Batch mode escapes
  # newlines inside trigger bodies, so one line = one trigger.
  # Family triggers are named trg_* and are reported apart from the dump's ra_* triggers.
  read -r other_triggers family_triggers ra_triggers ra_trigger_tables < <(
    dbq "SHOW TRIGGERS FROM \`$db_name\`" | awk -F'\t' '
      $1 ~ /^ra_/ { ra++; tables[$3] = 1; next }
      $1 ~ /^trg_/ { family++; next }
      { other++ }
      END { n = 0; for (t in tables) n++; print other + 0, family + 0, ra + 0, n }'
  )

  check() {
    local label="$1" expected="$2" actual="$3" mark="ok"
    if [[ "$actual" != "$expected" ]]; then mark="MISMATCH"; failures=$((failures + 1)); fi
    printf '  %-48s %8s  (expected %s)  %s\n' "$label" "$actual" "$expected" "$mark"
  }

  echo
  echo "Checks for $db_name:"
  check "base tables from the dump" "$EXPECTED_BASE_TABLES" "$base_tables"
  printf '  %-48s %8s  (0 after restore, 11 after migrations)\n' "family tables" "$family_tables"
  check "views" "$EXPECTED_VIEWS" "$views"
  check "children rows" "$EXPECTED_CHILDREN" "$children"
  check "children_additional_information rows" "$EXPECTED_CAI" "$cai"
  check "ra_* triggers (SHOW TRIGGERS)" "$EXPECTED_RA_TRIGGERS" "$ra_triggers"
  check "tables with ra_* triggers" "$EXPECTED_RA_TRIGGER_TABLES" "$ra_trigger_tables"
  check "other triggers (not ra_* or family trg_*)" 0 "$other_triggers"
  printf '  %-48s %8s  (0 after restore, 17 after migrations)\n' "family trg_* triggers" "$family_triggers"
  check "non-family stored routines (none in the dump)" "$EXPECTED_ROUTINES" "$routines"

  echo
  echo "Audit triggers on children and children_additional_information:"
  db -t -e "SELECT TRIGGER_NAME AS \`Trigger\`, ACTION_TIMING AS Timing, EVENT_MANIPULATION AS Event,
                   EVENT_OBJECT_TABLE AS \`Table\`, DEFINER AS Definer
            FROM information_schema.TRIGGERS
            WHERE TRIGGER_SCHEMA = '$db_name'
              AND EVENT_OBJECT_TABLE IN ('children', 'children_additional_information')
            ORDER BY EVENT_OBJECT_TABLE, ACTION_ORDER, TRIGGER_NAME"

  if (( failures > 0 )); then
    die "$failures check(s) failed for $db_name"
  fi
  echo "All checks passed for $db_name."
}
