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

cleanup() {
  run_psql postgres "DROP DATABASE IF EXISTS \"$SCRATCH\";" >/dev/null 2>&1 || true
  if [ -n "${TMP_DUMP:-}" ] && [ -f "$TMP_DUMP" ]; then rm -f "$TMP_DUMP"; fi
  if [ -n "${TMP_PLAIN:-}" ] && [ -f "$TMP_PLAIN" ]; then rm -f "$TMP_PLAIN"; fi
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

# Verify the artifact before touching it. A sidecar written by db-backup.sh is
# used automatically; EXPECTED_SHA256 lets an operator pin a known checksum.
expected_sha="${EXPECTED_SHA256:-}"
if [ -z "$expected_sha" ] && [ -f "$DUMP.sha256" ]; then
  expected_sha="$(awk '{print $1}' "$DUMP.sha256")"
fi
if [ -n "$expected_sha" ]; then
  actual_sha="$(sha256sum "$DUMP" | awk '{print $1}')"
  if [ "$actual_sha" != "$expected_sha" ]; then
    echo "error: checksum mismatch for $DUMP" >&2
    echo "  expected $expected_sha" >&2
    echo "  actual   $actual_sha" >&2
    exit 1
  fi
  echo "== checksum verified"
fi

if [[ "$DUMP" == *.gpg ]]; then
  if ! command -v gpg >/dev/null 2>&1; then
    echo "error: encrypted backup requires gpg with the matching key or passphrase" >&2
    exit 1
  fi
  TMP_PLAIN="$(mktemp -t wpay-backup-XXXXXX.dump)"
  if [ -n "${BACKUP_GPG_PASSPHRASE:-}" ]; then
    printf '%s' "$BACKUP_GPG_PASSPHRASE" | gpg --batch --yes --pinentry-mode loopback \
      --passphrase-fd 0 --output "$TMP_PLAIN" --decrypt "$DUMP"
  else
    gpg --batch --yes --output "$TMP_PLAIN" --decrypt "$DUMP"
  fi
  DUMP="$TMP_PLAIN"
  echo "== decrypted backup"
fi

if command -v pg_restore >/dev/null 2>&1; then
  if ! pg_restore --list "$DUMP" >/dev/null; then
    echo "error: archive is unreadable: $(basename "$DUMP")" >&2
    exit 1
  fi
elif command -v docker >/dev/null 2>&1; then
  echo "warning: local pg_restore is unavailable; archive TOC was not validated" >&2
else
  echo "error: pg_restore is required to verify the archive" >&2
  exit 1
fi

RESTORE_STARTED_AT="$(date +%s)"
echo "== creating scratch database $SCRATCH"
run_psql postgres "CREATE DATABASE \"$SCRATCH\";"

echo "== restoring $(basename "$DUMP")"
run_restore "$TARGET_URL" "$DUMP"
RESTORE_SECONDS="$(( $(date +%s) - RESTORE_STARTED_AT ))"
echo "== restore wall time: ${RESTORE_SECONDS}s (scratch database creation + pg_restore)"

echo "== comparing row counts for every public table"
TABLES="$(run_psql "$DB_NAME" "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;")"
if [ -z "$TABLES" ]; then
  echo "error: source database has no public tables" >&2
  exit 1
fi
failed=0
while IFS= read -r table; do
  [ -z "$table" ] && continue
  source_count="$(run_psql "$DB_NAME" "SELECT count(*) FROM \"$table\";")"
  restored_count="$(run_psql "$TARGET_URL" "SELECT count(*) FROM \"$table\";")"
  if [ "$source_count" != "$restored_count" ]; then
    echo "MISMATCH $table: source=$source_count restored=$restored_count" >&2
    failed=1
  else
    printf '  %-24s %s rows\n' "$table" "$restored_count"
  fi
done <<< "$TABLES"

source_migrations="$(run_psql "$DB_NAME" "SELECT string_agg(migration_name, ',' ORDER BY migration_name) FROM _prisma_migrations WHERE finished_at IS NOT NULL;")"
restored_migrations="$(run_psql "$TARGET_URL" "SELECT string_agg(migration_name, ',' ORDER BY migration_name) FROM _prisma_migrations WHERE finished_at IS NOT NULL;")"
if [ "$source_migrations" != "$restored_migrations" ]; then
  echo "MISMATCH _prisma_migrations: applied migration sets differ" >&2
  failed=1
else
  echo "  applied migrations match"
fi

if [ "$failed" -ne 0 ]; then
  echo "restore drill FAILED" >&2
  exit 1
fi
echo "restore drill passed"
