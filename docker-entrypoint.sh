#!/usr/bin/env bash
set -euo pipefail

DATA_DIR="${KILNDB_DATA_DIR:-/data}"
APP_USER="kilndb"
APP_HOME="/home/kilndb"

mkdir -p "$DATA_DIR"

if [ "$(stat -c '%U' "$DATA_DIR")" != "$APP_USER" ]; then
  echo "[entrypoint] taking ownership of $DATA_DIR"
  chown -R "$APP_USER:$APP_USER" "$DATA_DIR"
fi

POINTER_DIR="$APP_HOME/.kilndb"
mkdir -p "$POINTER_DIR"
printf '{\n  "dataDir": "%s"\n}\n' "$DATA_DIR" > "$POINTER_DIR/config.json"
chmod 700 "$POINTER_DIR"
chmod 600 "$POINTER_DIR/config.json"
chown -R "$APP_USER:$APP_USER" "$POINTER_DIR"

echo "[entrypoint] starting KilnDB as '$APP_USER' (data dir: $DATA_DIR)"

exec gosu "$APP_USER" env HOME="$APP_HOME" bun run /app/apps/api/src/index.ts
