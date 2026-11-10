#!/usr/bin/env bash
# Starts a throwaway local Postgres 16 cluster for Smooth Operators tests.
# Usage: scripts/so-test-db.sh start|stop
# Exposes postgres://postgres@127.0.0.1:${SO_TEST_PGPORT:-54329}
set -euo pipefail
PORT="${SO_TEST_PGPORT:-54329}"
BIN="${SO_PG_BIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
DIR="${SO_PG_DIR:-/var/lib/postgresql/so-test}"
run() { if [ "$(id -u)" = "0" ]; then su postgres -c "$*"; else bash -c "$*"; fi; }

case "${1:-start}" in
  start)
    if [ ! -d "$DIR/data" ]; then
      run "mkdir -p '$DIR' && '$BIN/initdb' -D '$DIR/data' -A trust -U postgres >/dev/null"
    fi
    if ! run "'$BIN/pg_ctl' -D '$DIR/data' status" >/dev/null 2>&1; then
      run "'$BIN/pg_ctl' -D '$DIR/data' -o '-p $PORT -k $DIR -c fsync=off' -l '$DIR/log' -w start" >/dev/null
    fi
    echo "postgres://postgres@127.0.0.1:$PORT"
    ;;
  stop)
    run "'$BIN/pg_ctl' -D '$DIR/data' -m fast stop" || true
    ;;
esac
