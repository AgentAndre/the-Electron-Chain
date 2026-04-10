#!/usr/bin/env bash
set -e

echo "================================================"
echo " Peaq Energy Trading Hub v3.2.0"
echo " Anker Solix + Zendure Hyper 2000 + Peaq"
echo "================================================"

# Ensure data directory exists
mkdir -p /data

# The Node.js app reads /data/options.json directly (with env var overrides and
# built-in defaults). No bashio dependency needed.
cd /app
exec node index.js
