# P2P Energy Trading System v3.0.0

## Anker Solix 1600 AC + Zendure Hyper 2000 + Peaq Blockchain

Ein Home Assistant Add-on für **Peer-to-Peer Energiehandel** zwischen zwei Parteien mit Visualisierung auf einer Karte.

---

## Was ist neu in v3.0.0

- Interaktive Karte von Köln mit Energiefluss-Visualisierung
- Zendure Hyper 2000 Integration
- Verbesserter 48h EPEX Forecast mit Balkendiagramm
- P2P Trading zwischen zwei Parteien
- Elegantes dunkles Design ohne Emojis
- Anker Solix 1600 AC Netzladen (basierend auf deiner Automation)

---

## Features

### P2P Energiehandel
- Automatischer Handel zwischen zwei Batteriespeichern
- Verkäufer entlädt Batterie um X Wh
- Käufer lädt Batterie um X Wh
- Trades werden auf der Peaq Blockchain gespeichert

### Unterstützte Speicher
| Gerät | Integration | Laden | Entladen |
|-------|-------------|-------|----------|
| Anker Solix 1600 AC | ha-anker-solix (HACS) | AC Notladung | Output Preset |
| Zendure Hyper 2000 | Zendure-HA (HACS) | Input Limit | Output Limit |

### Dashboard
- Interaktive Karte (Leaflet.js, Dark Theme)
- 48h EPEX Preisprognose
- Echtzeit Batteriestand beider Parteien
- Energiefluss-Visualisierung
- Trade-Historie

---

## Voraussetzungen

### 1. Anker Solix HACS Integration
```
HACS → Integrations → Custom Repositories
→ https://github.com/thomluther/ha-anker-solix
→ Installieren
```

### 2. Zendure HACS Integration
```
HACS → Integrations → Custom Repositories
→ https://github.com/Zendure/Zendure-HA
→ Installieren
```

**Wichtig:** Für Zendure einen zweiten Account erstellen (sonst wird man aus der App ausgeloggt).

### 3. EPEX Spot Integration
```
HACS → Integrations → Suche: "EPEX Spot"
→ Installieren → Deutschland auswählen
```

---

##  Installation

```bash
# 1. Per SSH verbinden
ssh root@homeassistant.local

# 2. Addon kopieren
scp -r peaq-energy-trading root@homeassistant.local:/addons/

# 3. In HA installieren
# Settings → Add-ons → Reload → P2P Energy Trading
```

---

## Konfiguration

### Partei 1: Gertrud Koch Str (Anker Solix)
```yaml
party1_name: "Gertrud Koch Str"
party1_lat: 50.9333
party1_lon: 6.9500
anker_battery_sensor: "sensor.solarbank_2_e1600_battery_charge"
anker_power_sensor: "sensor.solarbank_2_e1600_output_power"
anker_output_control: "number.solarbank_2_e1600_output_preset"
anker_ac_charging: "switch.solarbank_2_e1600_ac_notladeoption"
anker_device_id: "b8214a38bd446ccbf2837f3c71ff5309"
```

### Partei 2: Eilendorfer Str (Zendure Hyper 2000)
```yaml
party2_name: "Eilendorfer Str"
party2_lat: 50.7717
party2_lon: 6.1244
zendure_battery_sensor: "sensor.hyper_2000_electric_level"
zendure_power_sensor: "sensor.hyper_2000_output_power"
zendure_output_control: "number.hyper_2000_output_limit"
zendure_input_control: "number.hyper_2000_input_limit"
zendure_ac_mode: "select.hyper_2000_ac_mode"
```

### Trading Einstellungen (basierend auf Laden@Night Automation)
```yaml
enable_trading: true
min_sell_price: 0.25        # Verkaufen ab 25 ct/kWh
max_buy_price: 0.22         # Kaufen unter 22 ct/kWh (wie in deiner Automation)
min_buy_price: 0.02         # Nicht kaufen unter 2 ct (negative Preise vermeiden)
battery_reserve: 20         # Minimum 20% behalten
p2p_trade_amount_wh: 100    # 100 Wh pro Trade
```

---

## Anker Solix Netzladen

Das Addon verwendet die gleiche Logik wie deine Automation:

```yaml
# Wird automatisch ausgeführt bei niedrigen Preisen:
- service: number.set_value
  target:
    entity_id: number.solarbank_2_e1600_output_preset
  data:
    value: 800

- service: switch.turn_on
  target:
    entity_id: switch.solarbank_2_e1600_ac_notladeoption

- service: anker_solix.modify_solix_backup_charge
  data:
    device_id: b8214a38bd446ccbf2837f3c71ff5309
    enable_backup: true
    backup_duration:
      hours: 2
      minutes: 0
      seconds: 0
    backup_start: "{{ now() }}"
```

---

## Zendure Hyper 2000 Steuerung

| Aktion | Service | Entity |
|--------|---------|--------|
| Laden starten | `number.set_value` | `number.hyper_2000_input_limit` |
| Entladen starten | `number.set_value` | `number.hyper_2000_output_limit` |
| Modus ändern | `select.select_option` | `select.hyper_2000_ac_mode` |

Modi: `charge`, `discharge`, `auto`

---

## Dashboard

Nach dem Start: `http://homeassistant.local:8099`

### Ansichten
- **Karte**: Zeigt beide Standorte in Köln mit animiertem Energiefluss
- **48h Forecast**: Balkendiagramm der EPEX Preise
- **Batterien**: Füllstand, Leistung, Status beider Speicher
- **Trades**: Historie der P2P Transaktionen

---

## P2P Trading Logik

```
WENN Preis >= min_sell_price:
  WENN Party1.Battery > Party2.Battery + 10%:
    → Party1 verkauft an Party2
  SONST WENN Party2.Battery > Party1.Battery + 10%:
    → Party2 verkauft an Party1

WENN Preis <= max_buy_price:
  → Beide laden aus dem Netz
```

Bei einem Trade:
1. Verkäufer-Batterie entlädt um `p2p_trade_amount_wh`
2. Käufer-Batterie lädt um `p2p_trade_amount_wh`
3. Trade wird auf Peaq Blockchain gespeichert

---

## Dateien

```
peaq-energy-trading/
├── config.yaml          # Add-on Konfiguration
├── Dockerfile           # Container Build
├── build.yaml           # Multi-Arch Build
├── package.json         # Node.js Dependencies
├── README.md            # Diese Datei
└── rootfs/
    ├── run.sh           # Startup Script
    └── app/
        └── index.js     # Haupt-Applikation (900+ Zeilen)
```

---

## Peaq Blockchain

### Wallet Funding (Testnet) - Via Discord

1. Dashboard öffnen → Wallet-Adresse kopieren
2. Peaq Discord beitreten: https://discord.gg/peaq
3. `#get-roles` → Crane-Emoji klicken
4. `#agung-faucet` → `!send DEINE_WALLET_ADRESSE`

---

## Troubleshooting

### Entities finden
```
Developer Tools → States → Suche: "solarbank" oder "hyper_2000"
```

### Zendure nicht sichtbar
- Zweiten Zendure Account erstellen
- Geräte vom Hauptaccount teilen
- Integration mit Zweitaccount konfigurieren

### EPEX Preise fehlen
- EPEX Spot Integration prüfen
- Sensor `sensor.epex_spot_data_total_price` muss existieren

---

## Lizenz

Apache 2.0
