#!/usr/bin/env bash
# Restores a backup into an isolated database and compares row counts with the
# source. This is the restore drill referenced by docs/DISASTER_RECOVERY.md: it
# fails on any mismatch and always drops the scratch database on exit.
#
# Local (compose) usage:
#   POSTGRES_PASSWORD=wpay_local_only scripts/db-restore-drill.sh
# CI usage (PostgreSQL client + reachable server):
#   DATABASE_URL=postgresql://... PGPASSWORD=... scripts/db-restore-drill.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DUMP="${1:-}"
CONTAINER="${WPAY_PG_CONTAINER:-w-pay-postgres-1}"
DB_USER="${POSTGRES_USER:-wpay}"
DB_NAME="${POSTGRES_DB:-wpay}"
SCRATCH="wpay_restore_drill_$$"
TABLES=(User Merchant Payment Invoice Refund IndexedEvent IndexerCheckpoint _prisma_migrations)

cleanup() {
  run_psql postgres "DROP DATABASE IF EXISTS \"$SCRATCH\";" >/dev/null 2>&1 || true
  if [ -n "${TMP_DUMP:-}" ] && [ -f "$TMP_DUMP" ]; then rm -f "$TMP_DUMP"; fi
}
trap cleanup EXIT

if command -v psql >/dev/null 2>&1; then
  if [ -z "${DATABASE_URL:-}" ]; then
    echo "error: DATABASE_URL is required when the PostgreSQL client is installed" >&2
    exit 1
  fi
  # Connection details come from the standard PG* variables or the URL.
  # shellcheck disable=SC2317
  run_psql() {
    local database="$1" sql="$2"
    psql -d "$database" -v ON_ERROR_STOP=1 -Atc "$sql"
  }
  run_restore() {
    pg_restore --no-owner --no-privileges --exit-on-error --dbname="$1" "$2"
  }
  TARGET_URL="$SCRATCH"
else
  if [ -z "${POSTGRES_PASSWORD:-}" ]; then
    echo "error: install the PostgreSQL client or set POSTGRES_PASSWORD for the docker fallback" >&2
    exit 1
  fi
  # shellcheck disable=SC2317
  run_psql() {
    local database="$1" sql="$2"
    docker exec -e PGPASSWORD="$POSTGRES_PASSWORD" "$CONTAINER" \
      psql -U "$DB_USER" -d "$database" -v ON_ERROR_STOP=1 -Atc "$sql"
  }
  run_restore() {
    docker exec -i -e PGPASSWORD="$POSTGRES_PASSWORD" "$CONTAINER" \
      pg_restore -U "$DB_USER" -d "$1" --no-owner --no-privileges --exit-on-error < "$2"
  }
  TARGET_URL="$SCRATCH"
fi

if [ -z "$DUMP" ]; then
  TMP_DUMP="$(mktemp -t wpay-backup-XXXXXX.dump)"
  DUMP="$TMP_DUMP"
  echo "== creating a fresh backup for the drill"
  if command -v pg_dump >/dev/null 2>&1; then
    pg_dump --format=custom --no-owner --no-privileges --file="$DUMP" "$DATABASE_URL"
  else
    docker exec -e PGPASSWORD="$POSTGRES_PASSWORD" "$CONTAINER" \
      pg_dump -U "$DB_USER" -d "$DB_NAME" --format=custom --no-owner --no-privileges > "$DUMP"
  fi
fi

if [ ! -s "$DUMP" ]; then
  echo "error: dump file is missing or empty: $DUMP" >&2
  exit 1
fi

echo "== creating scratch database $SCRATCH"
run_psql postgres "CREATE DATABASE \"$SCRATCH\";"

echo "== restoring $(basename "$DUMP")"
run_restore "$TARGET_URL" "$DUMP"

echo "== comparing row counts"
failed=0
for table in "${TABLES[@]}"; do
  source_count="$(run_psql "$DB_NAME" "SELECT count(*) FROM \"$table\";")"
  restored_count="$(run_psql "$TARGET_URL" "SELECT count(*) FROM \"$table\";")"
  if [ "$source_count" != "$restored_count" ]; then
    echo "MISMATCH $table: source=$source_count restored=$restored_count" >&2
    failed=1
  else
    printf '  %-20s %s rows\n' "$table" "$restored_count"
  fi
done

if [ "$failed" -ne 0 ]; then
  echo "restore drill FAILED" >&2
  exit 1
fi
echo "restore drill passed"
