#!/bin/sh
set -eu

if [ -n "${TZ:-}" ]; then
  # The app records and displays local schedule/history times. Let deployments
  # set TZ without baking a region-specific timezone into the image.
  echo "$TZ" > /etc/timezone 2>/dev/null || true
  if [ -f "/usr/share/zoneinfo/$TZ" ]; then
    ln -snf "/usr/share/zoneinfo/$TZ" /etc/localtime
  else
    echo "warning: zoneinfo file not found for TZ=$TZ" >&2
  fi
fi

# Caddy starts with an admin-only base config and is reconfigured by the app
# through its Admin API. Persistence is disabled in the app-provided config so
# DNS credentials are never written to disk by Caddy. All Caddy state lives in
# DATA_DIR/caddy so it persists alongside the rest of the application data.
CADDY_DIR="${DATA_DIR:-/data}/caddy"
mkdir -p "$CADDY_DIR"
export XDG_DATA_HOME="$CADDY_DIR"
export XDG_CONFIG_HOME="$CADDY_DIR"
cat > "$CADDY_DIR/base.Caddyfile" <<EOF
{
	admin 127.0.0.1:2019
	storage file_system ${CADDY_DIR}
	persist_config off
	auto_https disable_redirects
}
EOF

CADDY_PID=
if command -v caddy >/dev/null 2>&1; then
  (
    while :; do
      caddy run --config "$CADDY_DIR/base.Caddyfile" --adapter caddyfile || true
      echo "caddy exited; restarting in 2s" >&2
      sleep 2
    done
  ) &
  CADDY_PID=$!
fi

"$@" &
APP_PID=$!

shutdown() {
  kill -TERM "$APP_PID" 2>/dev/null || true
  caddy stop 2>/dev/null || true
  [ -n "$CADDY_PID" ] && kill -TERM "$CADDY_PID" 2>/dev/null || true
}
trap shutdown INT TERM

set +e
wait "$APP_PID"
STATUS=$?
set -e

caddy stop 2>/dev/null || true
[ -n "$CADDY_PID" ] && kill -TERM "$CADDY_PID" 2>/dev/null || true
exit "$STATUS"
