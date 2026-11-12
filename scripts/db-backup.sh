#!/usr/bin/env bash
# Creates a custom-format PostgreSQL backup and prints its SHA-256.
#
# Uses a local pg_dump when available (CI, operations hosts). In local
# development it falls back to pg_dump inside the compose Postgres container.
#
# Usage:
#   DATABASE_URL=postgresql://... scripts/db-backup.sh [output.dump]
#   POSTGRES_PASSWORD=wpay_local_only scripts/db-backup.sh   # docker fallback
#
# Encryption (recommended for off-site copies):
#   BACKUP_GPG_RECIPIENT=ops@example.com scripts/db-backup.sh
# writes <output>.gpg and removes the plaintext dump. Encrypting here means the
# plaintext never reaches the off-site location. Test restoration with
# scripts/db-restore-drill.sh <file>.gpg (it decrypts with the local secret key).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${1:-$ROOT/backups/wpay-$(date -u +%Y%m%dT%H%M%SZ).dump}"
mkdir -p "$(dirname "$OUT")"

if command -v pg_dump >/dev/null 2>&1; then
  if [ -z "${DATABASE_URL:-}" ]; then
    echo "error: DATABASE_URL is required when pg_dump is installed" >&2
    exit 1
  fi
  pg_dump --format=custom --no-owner --no-privileges --file="$OUT" "$DATABASE_URL"
else
  CONTAINER="${WPAY_PG_CONTAINER:-w-pay-postgres-1}"
  USER_NAME="${POSTGRES_USER:-wpay}"
  DB_NAME="${POSTGRES_DB:-wpay}"
  if [ -z "${POSTGRES_PASSWORD:-}" ]; then
    echo "error: install the PostgreSQL client or set POSTGRES_PASSWORD for the docker fallback" >&2
    exit 1
  fi
  docker exec -e PGPASSWORD="$POSTGRES_PASSWORD" "$CONTAINER" \
    pg_dump -U "$USER_NAME" -d "$DB_NAME" --format=custom --no-owner --no-privileges > "$OUT"
fi

if [ ! -s "$OUT" ]; then
  echo "error: backup is empty: $OUT" >&2
  exit 1
fi

if [ -n "${BACKUP_GPG_RECIPIENT:-}" ]; then
  if ! command -v gpg >/dev/null 2>&1; then
    echo "error: BACKUP_GPG_RECIPIENT is set but gpg is not installed" >&2
    exit 1
  fi
  gpg --batch --yes --trust-model always --recipient "$BACKUP_GPG_RECIPIENT" \
    --output "$OUT.gpg" --encrypt "$OUT"
  rm -f "$OUT"
  OUT="$OUT.gpg"
  echo "backup encrypted: $OUT"
else
  echo "backup written: $OUT"
  echo "warning: dump is unencrypted; set BACKUP_GPG_RECIPIENT for off-site copies" >&2
fi
sha256sum "$OUT"
