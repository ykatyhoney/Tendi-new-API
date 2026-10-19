#!/usr/bin/env bash
# Family migration runner. Applies migrations/family/family_NNN_<name>.sql and
# reverts them with the matching family_NNN_<name>.down.sql, recording each one in
# the tenant database's existing schema_migrations table in the same format as the
# PHP app's tool: version (family_NNN), filename, checksum (SHA-1 of the up file),
# batch, status, applied_at, execution_ms, applied_by, error_message.
#
# Usage:
#   npm run db:family:migrate              apply every pending migration (one new batch)
#   npm run db:family:migrate:down         revert the most recent family batch
#   npm run db:family:migrate:down -- --all  revert every applied family migration
#   npm run db:family:migrate:status       list migrations and their state
#
# Targets DB_NAME from .env; DB_NAME=tendi_family_test npm run ... targets the test copy.
# Only rows whose version starts with family_ are read or written.
# MariaDB commits DDL implicitly, so each migration file holds one DDL statement:
# a failure then leaves nothing half-applied.

source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

MIGRATIONS_DIR="$API_ROOT/migrations/family"
APPLIED_BY="family-migrate"

sql_str() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\'/\'\'}"
  printf "'%s'" "$s"
}

now_us() { printf '%s\n' "${EPOCHREALTIME/[.,]/}"; }

# Up files in version order. Every up file must have a down file.
list_migrations() {
  local file name
  for file in "$MIGRATIONS_DIR"/family_*.sql; do
    name="$(basename "$file")"
    [[ "$name" == *.down.sql ]] && continue
    [[ "$name" =~ ^family_[0-9]{3}_[a-z0-9_]+\.sql$ ]] || die "bad migration file name: $name"
    [[ -f "${file%.sql}.down.sql" ]] || die "$name has no down step (${name%.sql}.down.sql)"
    printf '%s\n' "$name"
  done | LC_ALL=C sort
}

version_of() { [[ "$1" =~ ^(family_[0-9]{3})_ ]] && printf '%s\n' "${BASH_REMATCH[1]}"; }

checksum_of() { sha1sum "$MIGRATIONS_DIR/$1" | cut -c1-40; }

# version<TAB>status<TAB>batch<TAB>checksum<TAB>filename for every family row.
recorded_rows() {
  dbq "SELECT version, status, batch, checksum, filename FROM schema_migrations
       WHERE version LIKE 'family\\_%' ORDER BY version" "$DB_NAME"
}

declare -A REC_STATUS REC_BATCH REC_CHECKSUM REC_FILE
load_recorded() {
  local version status batch checksum filename
  REC_STATUS=() REC_BATCH=() REC_CHECKSUM=() REC_FILE=()
  while IFS=$'\t' read -r version status batch checksum filename; do
    [[ -n "$version" ]] || continue
    REC_STATUS[$version]="$status"
    REC_BATCH[$version]="$batch"
    REC_CHECKSUM[$version]="$checksum"
    REC_FILE[$version]="$filename"
  done < <(recorded_rows)
}

# Runs one SQL file; on failure prints the error and returns non-zero.
run_file() {
  local file="$1" err
  if ! err="$(db "$DB_NAME" < "$file" 2>&1 >/dev/null)"; then
    printf '%s\n' "$err"
    return 1
  fi
}

cmd_up() {
  local migrations=() name version checksum batch started ms err pending=0
  mapfile -t migrations < <(list_migrations)
  load_recorded

  # Refuse to continue if an applied migration's file changed since it ran.
  for name in "${migrations[@]}"; do
    version="$(version_of "$name")"
    if [[ "${REC_STATUS[$version]:-}" == applied ]]; then
      checksum="$(checksum_of "$name")"
      [[ "$checksum" == "${REC_CHECKSUM[$version]}" ]] \
        || die "$name changed after it was applied (checksum ${REC_CHECKSUM[$version]} recorded, $checksum now); add a new migration instead"
    fi
  done

  batch="$(dbq "SELECT COALESCE(MAX(batch), 0) + 1 FROM schema_migrations" "$DB_NAME")"
  for name in "${migrations[@]}"; do
    version="$(version_of "$name")"
    [[ "${REC_STATUS[$version]:-}" == applied ]] && continue
    pending=$((pending + 1))
    checksum="$(checksum_of "$name")"
    printf 'up    %-45s ' "$name"
    started="$(now_us)"
    if err="$(run_file "$MIGRATIONS_DIR/$name")"; then
      ms=$(( ($(now_us) - started) / 1000 ))
      dbq "INSERT INTO schema_migrations
             (version, filename, checksum, batch, status, applied_at, execution_ms, applied_by, error_message)
           VALUES ($(sql_str "$version"), $(sql_str "$name"), '$checksum', $batch, 'applied', NOW(), $ms,
                   $(sql_str "$APPLIED_BY"), NULL)
           ON DUPLICATE KEY UPDATE filename = VALUES(filename), checksum = VALUES(checksum),
             batch = VALUES(batch), status = 'applied', applied_at = VALUES(applied_at),
             execution_ms = VALUES(execution_ms), applied_by = VALUES(applied_by), error_message = NULL" "$DB_NAME"
      echo "ok (${ms} ms, batch $batch)"
    else
      ms=$(( ($(now_us) - started) / 1000 ))
      dbq "INSERT INTO schema_migrations
             (version, filename, checksum, batch, status, applied_at, execution_ms, applied_by, error_message)
           VALUES ($(sql_str "$version"), $(sql_str "$name"), '$checksum', $batch, 'failed', NOW(), $ms,
                   $(sql_str "$APPLIED_BY"), $(sql_str "$err"))
           ON DUPLICATE KEY UPDATE filename = VALUES(filename), checksum = VALUES(checksum),
             batch = VALUES(batch), status = 'failed', applied_at = VALUES(applied_at),
             execution_ms = VALUES(execution_ms), applied_by = VALUES(applied_by),
             error_message = VALUES(error_message)" "$DB_NAME"
      echo "FAILED"
      die "$name failed (recorded as failed in schema_migrations): $err"
    fi
  done
  (( pending > 0 )) || echo "Nothing to apply: every family migration is applied."
}

cmd_down() {
  local all="${1:-}" migrations=() name version target_batch down_file err reverted=0
  [[ -z "$all" || "$all" == --all ]] || die "unknown option for down: $all"
  mapfile -t migrations < <(list_migrations)
  load_recorded

  target_batch="$(dbq "SELECT MAX(batch) FROM schema_migrations
                       WHERE version LIKE 'family\\_%' AND status = 'applied'" "$DB_NAME")"
  if [[ -z "$target_batch" || "$target_batch" == NULL ]]; then
    echo "Nothing to revert: no family migration is applied."
    return
  fi

  for version in "${!REC_STATUS[@]}"; do
    [[ "${REC_STATUS[$version]}" == applied ]] || continue
    [[ -f "$MIGRATIONS_DIR/${REC_FILE[$version]}" ]] \
      || die "$version is applied but ${REC_FILE[$version]} is missing; cannot revert it"
  done

  # Newest first.
  for (( i = ${#migrations[@]} - 1; i >= 0; i-- )); do
    name="${migrations[$i]}"
    version="$(version_of "$name")"
    [[ "${REC_STATUS[$version]:-}" == applied ]] || continue
    [[ "$all" == --all || "${REC_BATCH[$version]}" == "$target_batch" ]] || continue
    down_file="$MIGRATIONS_DIR/${name%.sql}.down.sql"
    printf 'down  %-45s ' "$(basename "$down_file")"
    if ! err="$(run_file "$down_file")"; then
      echo "FAILED"
      die "${name%.sql}.down.sql failed; $version stays recorded as applied: $err"
    fi
    dbq "DELETE FROM schema_migrations WHERE version = $(sql_str "$version") AND status = 'applied'" "$DB_NAME"
    echo "ok"
    reverted=$((reverted + 1))
  done
  echo "Reverted $reverted migration(s)."
}

cmd_status() {
  local migrations=() name version state
  mapfile -t migrations < <(list_migrations)
  load_recorded
  echo "Family migrations in $DB_NAME:"
  for name in "${migrations[@]}"; do
    version="$(version_of "$name")"
    case "${REC_STATUS[$version]:-}" in
      applied)
        state="applied (batch ${REC_BATCH[$version]})"
        [[ "$(checksum_of "$name")" == "${REC_CHECKSUM[$version]}" ]] || state="$state, FILE CHANGED since applied"
        ;;
      "") state="pending" ;;
      *) state="${REC_STATUS[$version]}" ;;
    esac
    printf '  %-45s %s\n' "$name" "$state"
  done
  for version in "${!REC_STATUS[@]}"; do
    [[ -f "$MIGRATIONS_DIR/${REC_FILE[$version]}" ]] \
      || printf '  %-45s %s (file missing)\n' "${REC_FILE[$version]}" "${REC_STATUS[$version]}"
  done
}

command="${1:-}"
shift || true
case "$command" in
  up|down|status) ;;
  *) die "usage: migrate.sh up | down [--all] | status" ;;
esac

load_env
init_client
check_server
database_exists "$DB_NAME" || die "$DB_NAME does not exist; run npm run db:family:restore first"

"cmd_$command" "$@"
