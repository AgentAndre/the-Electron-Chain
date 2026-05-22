#!/usr/bin/env bash
set -e

echo "==============================================================="
echo " The Electron Chain v5.0.0 — ELP-Hub (Python)"
echo " Cooperative §42c · peaq Agung · Fernet-wrapped wallet vault"
echo "==============================================================="

# Default timezone (overridden by HA addon options.timezone via hub.py).
export TZ="${TZ:-Europe/Berlin}"

# /data is HA Supervisor's persistent addon volume — survives upgrades.
mkdir -p /data

cd /app
exec python3 -u hub.py
