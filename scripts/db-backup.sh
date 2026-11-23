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
#   BACKUP_GPG_PASSPHRASE=... scripts/db-backup.sh   # symmetric AES-256
# writes <output>.gpg, removes the plaintext dump, writes <output>.gpg.sha256
# and prints the checksum. Encrypting here means the plaintext never reaches the
# off-site location. Test restoration with scripts/db-restore-drill.sh <file>.gpg.
#
# Retention:
#   BACKUP_RETENTION_DAYS=30 scripts/db-backup.sh
# deletes only wpay-*.dump / .dump.gpg / checksum files older than the cutoff in
# the output directory.
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${1:-$ROOT/backups/wpay-$(date -u +%Y%m%dT%H%M%SZ).dump}"
mkdir -p "$(dirname "$OUT")"

if [ -n "${BACKUP_GPG_RECIPIENT:-}${BACKUP_GPG_PASSPHRASE:-}" ] && ! command -v gpg >/dev/null 2>&1; then
  echo "error: backup encryption is configured but gpg is not installed" >&2
  exit 1
fi
if [ -n "${BACKUP_RETENTION_DAYS:-}" ] && ! [[ "$BACKUP_RETENTION_DAYS" =~ ^[0-9]+$ ]]; then
  echo "error: BACKUP_RETENTION_DAYS must be a whole number of days" >&2
  exit 1
fi

if command -v pg_dump >/dev/null 2>&1; then
  if [ -z "${DATABASE_URL:-}" ]; then
    echo "error: DATABASE_URL is required when pg_dump is installed" >&2
    exit 1
  fi
  if ! command -v node >/dev/null 2>&1; then
    echo "error: node is required to normalize DATABASE_URL for pg_dump" >&2
    exit 1
  fi
  # Prisma adds ?schema=public; libpq rejects it. Normalize without logging.
  PG_URL="$(node "$ROOT/scripts/pg-url.mjs")" || {
    echo "error: DATABASE_URL could not be normalized for PostgreSQL" >&2
    exit 1
  }
  pg_dump --format=custom --no-owner --no-privileges --file="$OUT" "$PG_URL"
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

# A dump that pg_restore cannot even list is not a backup. Validate the
# archive before encrypting or publishing it.
if command -v pg_restore >/dev/null 2>&1; then
  if ! pg_restore --list "$OUT" >/dev/null; then
    echo "error: pg_restore cannot read the generated archive: $OUT" >&2
    exit 1
  fi
elif command -v docker >/dev/null 2>&1; then
  echo "warning: local pg_restore is unavailable; archive TOC was not validated" >&2
fi

if [ -n "${BACKUP_GPG_PASSPHRASE:-}" ]; then
  printf '%s' "$BACKUP_GPG_PASSPHRASE" | gpg --batch --yes --pinentry-mode loopback \
    --passphrase-fd 0 --symmetric --cipher-algo AES256 --output "$OUT.gpg" "$OUT"
  rm -f "$OUT"
  OUT="$OUT.gpg"
  if [ ! -s "$OUT" ]; then
    echo "error: encrypted backup is empty: $OUT" >&2
    exit 1
  fi
  echo "backup encrypted (symmetric AES-256): $OUT"
elif [ -n "${BACKUP_GPG_RECIPIENT:-}" ]; then
  gpg --batch --yes --trust-model always --recipient "$BACKUP_GPG_RECIPIENT" \
    --output "$OUT.gpg" --encrypt "$OUT"
  rm -f "$OUT"
  OUT="$OUT.gpg"
  if [ ! -s "$OUT" ]; then
    echo "error: encrypted backup is empty: $OUT" >&2
    exit 1
  fi
  echo "backup encrypted: $OUT"
else
  echo "backup written: $OUT"
  echo "warning: dump is unencrypted; set BACKUP_GPG_RECIPIENT for off-site copies" >&2
fi

# The sidecar is what restore verification and off-site transfer check.
( cd "$(dirname "$OUT")" && sha256sum "$(basename "$OUT")" > "$(basename "$OUT").sha256" )
cat "$OUT.sha256"

if [ -n "${BACKUP_RETENTION_DAYS:-}" ]; then
  echo "== pruning backups older than ${BACKUP_RETENTION_DAYS} days in $(dirname "$OUT")"
  find "$(dirname "$OUT")" -maxdepth 1 -type f \
    \( -name 'wpay-*.dump' -o -name 'wpay-*.dump.gpg' -o -name 'wpay-*.dump.sha256' -o -name 'wpay-*.dump.gpg.sha256' \) \
    -mtime +"$BACKUP_RETENTION_DAYS" -print -delete
fi
