#!/bin/sh
set -e

if [ -n "$TS_AUTHKEY" ]; then
  echo "[tailscale] Starting tailscaled (userspace networking)..."
  mkdir -p /var/lib/tailscale /var/run/tailscale
  tailscaled \
    --state=/var/lib/tailscale/tailscaled.state \
    --socket=/var/run/tailscale/tailscale.sock \
    --tun=userspace-networking \
    &
  # Wait for tailscaled to be ready
  for i in $(seq 1 10); do
    tailscale --socket=/var/run/tailscale/tailscale.sock status >/dev/null 2>&1 && break
    sleep 1
  done
  echo "[tailscale] Authenticating..."
  tailscale \
    --socket=/var/run/tailscale/tailscale.sock \
    up \
    --authkey="$TS_AUTHKEY" \
    --hostname="${TS_HOSTNAME:-hcs-sync}" \
    --accept-routes
  echo "[tailscale] Connected as ${TS_HOSTNAME:-hcs-sync}."
fi

exec "$@"
