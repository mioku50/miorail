#!/usr/bin/env bash
# Miorail's nightly database dump, kept on this host: the last seven nights and
# the last four Sundays, in /var/backups/miorail/{daily,weekly}.
#
# Run by miorail-db-backup.service as root. Every PostgreSQL step runs as
# postgres over the local socket, so no password is read or written here.
#
# A dump counts only after two checks, because a file that looks whole is not
# proof of a backup (a truncated pg_dump stream once passed gzip -t):
#   1. every live table is in the archive's table of contents;
#   2. the whole archive reads back.
# Until then it is a .partial file, removed on any failure. A failure fails
# the unit, and ops-alerts announces failed miorail-* units in Telegram.
#
# Nothing outside daily/ and weekly/ is touched: dumps kept by hand at the top
# of /var/backups/miorail (a host move's, say) stay until someone removes them.
set -euo pipefail
# The dumps hold every wallet's records and the roles' password hashes: owner only.
umask 077

DIR=/var/backups/miorail
PORT=5433
DB=miorail
KEEP_DAILY=7
KEEP_WEEKLY=4

as_pg() { runuser -u postgres -- "$@"; }

install -d -m 0700 -o postgres -g postgres "$DIR" "$DIR/daily" "$DIR/weekly"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
dump="$DIR/daily/miorail-$stamp.dump"
globals="$DIR/daily/globals-$stamp.sql"
part="$dump.partial"
trap 'rm -f "$part"' EXIT

# Room for the new dump next to the ones kept: twice the newest, and at least 3 GB.
newest=$(ls -1t "$DIR"/daily/miorail-*.dump 2>/dev/null | head -1 || true)
need=$(( 3 * 1024 * 1024 * 1024 ))
if [ -n "$newest" ]; then
  twice=$(( 2 * $(stat -c %s "$newest") ))
  [ "$twice" -gt "$need" ] && need=$twice
fi
free=$(( $(df --output=avail -B1 "$DIR" | tail -1) ))
if [ "$free" -lt "$need" ]; then
  echo "FAILED: $(( free / 1048576 )) MB free in $DIR, a dump needs $(( need / 1048576 )) MB"
  exit 1
fi

started=$(date +%s)
as_pg pg_dump -p "$PORT" -d "$DB" -Fc -Z 6 -f "$part"

live=$(as_pg psql -p "$PORT" -d "$DB" -XAtc \
  "select count(*) from pg_tables where schemaname not in ('pg_catalog','information_schema')")
archived=$(as_pg pg_restore -l "$part" | grep -c ' TABLE DATA ' || true)
if [ "$live" != "$archived" ]; then
  echo "FAILED: the archive holds $archived of the $live live tables"
  exit 1
fi
if ! as_pg pg_restore -f /dev/null "$part"; then
  echo "FAILED: the archive does not read back whole"
  exit 1
fi
mv "$part" "$dump"
# Roles and their password hashes: the directory is postgres's alone (0700).
as_pg pg_dumpall -p "$PORT" --globals-only -f "$globals"

# A Sunday's dump is also a weekly one: a hard link, no second copy.
if [ "$(date -u +%u)" = 7 ]; then
  ln -f "$dump" "$DIR/weekly/$(basename "$dump")"
  ln -f "$globals" "$DIR/weekly/$(basename "$globals")"
fi

prune() { # directory, how many to keep, file pattern; an empty directory is not a failure
  { ls -1t "$1"/$3 2>/dev/null || true; } | tail -n +$(( $2 + 1 )) | xargs -r rm -f --
}
prune "$DIR/daily" "$KEEP_DAILY" 'miorail-*.dump'
prune "$DIR/daily" "$KEEP_DAILY" 'globals-*.sql'
prune "$DIR/weekly" "$KEEP_WEEKLY" 'miorail-*.dump'
prune "$DIR/weekly" "$KEEP_WEEKLY" 'globals-*.sql'

echo "kept $(basename "$dump"): $(du -h "$dump" | cut -f1), $archived of $live tables, read back whole," \
  "in $(( $(date +%s) - started )) s; $(ls -1 "$DIR"/daily/miorail-*.dump | wc -l) nightly and" \
  "$(ls -1 "$DIR"/weekly/miorail-*.dump 2>/dev/null | wc -l) weekly on hand"
