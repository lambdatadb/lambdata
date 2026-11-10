#!/usr/bin/env bash
set -euo pipefail

DATA_DIR="${LAMBDATA_DATA_DIR:-${KILNDB_DATA_DIR:-/data}}"
APP_USER="lambdata"
APP_HOME="/home/lambdata"
APP_UID="$(id -u "$APP_USER")"
APP_GID="$(id -g "$APP_USER")"
FIX_OWNERSHIP="${LAMBDATA_FIX_DATA_OWNERSHIP:-auto}"
export LAMBDATA_DATA_DIR="$DATA_DIR"

log() {
  echo "[entrypoint] $*"
}

count_foreign() {
  find "$DATA_DIR" -xdev \( ! -uid "$APP_UID" -o ! -gid "$APP_GID" \) -print 2>/dev/null | wc -l | tr -d ' '
}

mkdir -p "$DATA_DIR"

current="$(stat -c '%u:%g' "$DATA_DIR")"
if [ "$current" != "$APP_UID:$APP_GID" ]; then
  log "WARNING: $DATA_DIR is owned by $current, but LambData runs as $APP_USER ($APP_UID:$APP_GID)."
  if [ "$FIX_OWNERSHIP" = "never" ]; then
    log "LAMBDATA_FIX_DATA_OWNERSHIP=never is set, so ownership is left alone. Run: chown -R $APP_UID:$APP_GID <the folder mounted at $DATA_DIR>"
    exit 1
  fi
  log "counting files and folders that belong to another user (this reads the whole data directory once)..."
  before="$(count_foreign)"
  log "changing the owner of $before file(s) and folder(s) under $DATA_DIR to $APP_UID:$APP_GID; files that already belong to $APP_USER are not touched"
  find "$DATA_DIR" -xdev \( ! -uid "$APP_UID" -o ! -gid "$APP_GID" \) -exec chown -h "$APP_UID:$APP_GID" {} +
  after="$(count_foreign)"
  log "ownership fixed: $((before - after)) changed, $after still owned by someone else"
fi

POINTER_DIR="$APP_HOME/.lambdata"
mkdir -p "$POINTER_DIR"
printf '{\n  "dataDir": "%s"\n}\n' "$DATA_DIR" > "$POINTER_DIR/config.json"
chmod 700 "$POINTER_DIR"
chmod 600 "$POINTER_DIR/config.json"
chown -R "$APP_UID:$APP_GID" "$POINTER_DIR"

log "starting LambData as '$APP_USER' (data dir: $DATA_DIR)"

exec gosu "$APP_USER" env HOME="$APP_HOME" bun run /app/apps/api/src/index.ts
