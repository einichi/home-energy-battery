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

exec "$@"
