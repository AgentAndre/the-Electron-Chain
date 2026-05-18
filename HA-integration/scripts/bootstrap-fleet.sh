#!/usr/bin/env bash
# Bootstraps configs/ha-{1..10}/ directories with sane defaults so each HA
# instance can boot without the manual onboarding wizard. After first boot,
# add the Electron Chain integration via the UI.
#
# Run from the project root:  ./scripts/bootstrap-fleet.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET_DIR="$ROOT/docker/configs"
COUNT="${1:-10}"

mkdir -p "$TARGET_DIR"

for i in $(seq 1 "$COUNT"); do
  DIR="$TARGET_DIR/ha-$i"
  mkdir -p "$DIR"

  # Minimal configuration.yaml — MQTT pre-wired to the in-network broker
  cat > "$DIR/configuration.yaml" <<EOF
# Auto-generated for ELP test fleet — instance $i

default_config:

http:
  use_x_forwarded_for: false
  trusted_proxies: []

logger:
  default: warning
  logs:
    custom_components.electron_chain: debug
    substrateinterface: warning

# MQTT to the shared ELP-Hub broker
mqtt:
  broker: mqtt
  port: 1883
  client_id: ha-$i

# Simulated PV / battery / grid sensors driven by a template.
# Replace with real device integrations later.
template:
  - sensor:
      - name: "Sim PV Power"
        unit_of_measurement: "W"
        state: >
          {% set hour = now().hour + now().minute / 60 %}
          {% set base = 4500 * (1 - ((hour - 13) ** 2) / 49) %}
          {{ [0, base | round(0)] | max + range(-200, 200) | random }}
        device_class: power

      - name: "Sim Battery Power"
        unit_of_measurement: "W"
        state: "{{ range(-2000, 2000) | random }}"
        device_class: power

      - name: "Sim Grid Export"
        unit_of_measurement: "W"
        state: >
          {{ states('sensor.sim_pv_power') | float(0)
             - states('sensor.sim_battery_power') | float(0)
             - 800 }}
        device_class: power
EOF

  # Pre-create an empty secrets.yaml
  : > "$DIR/secrets.yaml"

  echo "  created $DIR"
done

echo
echo "Done. ${COUNT} HA configs ready under $TARGET_DIR"
echo "Next: docker compose up -d  →  open http://localhost:8101 ... 81$(printf '%02d' "$COUNT")"
