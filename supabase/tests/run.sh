#!/bin/sh
# Runs the database security tests on a throwaway database.
#   Locally (PostgreSQL superuser via `su postgres`):  supabase/tests/run.sh
#   With a connection string (e.g. in CI):            DATABASE_URL=postgres://postgres:pw@localhost/postgres supabase/tests/run.sh
# Exits non-zero if any check fails.
set -e
D="$(cd "$(dirname "$0")/.." && pwd)"
SQL="$(mktemp /tmp/stockroom_test.XXXXXX.sql)"
cat "$D/tests/stubs.sql" "$D"/migrations/*.sql "$D/tests/security_test.sql" > "$SQL"
chmod 644 "$SQL"
if [ -n "$DATABASE_URL" ]; then
  psql "$DATABASE_URL" -q -X -c "drop database if exists stockroom_test with (force)" -c "create database stockroom_test"
  OUT="$(psql "$(echo "$DATABASE_URL" | sed 's#/[^/]*$#/stockroom_test#')" -q -X -v ON_ERROR_STOP=1 -tA -f "$SQL")"
else
  su postgres -c "dropdb --if-exists --force stockroom_test; createdb stockroom_test"
  OUT="$(su postgres -c "psql -q -X -v ON_ERROR_STOP=1 -tA -d stockroom_test -f $SQL")"
fi
rm -f "$SQL"
echo "$OUT"
echo "$OUT" | tail -1 | grep -q '^0 failed'
