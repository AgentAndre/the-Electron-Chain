# Changelog

## [2.2.0] - 2026-03-20

### Neu
- **Interaktive Karte** mit Köln/Aachen (Leaflet.js, Dark Theme)
- **Energiefluss-Visualisierung** animierte Linie zwischen Haushalten
- **Zendure Hyper 2000** vollständige Integration (Laden/Entladen)
- **48h EPEX Forecast** mit funktionierendem Balkendiagramm
- **P2P Energy Trading** mit Batteriesteuerung
- **Anker Solix 1600 AC** Netzladen identisch mit Laden@Night Automation

### Geändert
- Komplett überarbeitetes Dashboard (dunkler, eleganter, keine Emojis)
- Trading-Schwellen angepasst: max_buy_price 0.22, min_buy_price 0.02
- Verbesserte EPEX Forecast-Darstellung (Sell/Buy/Hold farbcodiert)

### Konfiguration
- `min_buy_price` hinzugefügt (verhindert negative Preise)
- Standorte: Gertrud-Koch-Str. (Köln) + Eilendorfer Str. (Aachen)

## [3.0.0] - 2026-03-09

### Neu
- **P2P Energy Trading** zwischen zwei Parteien
- **Interaktive Karte** von Köln mit Leaflet.js (Dark Theme)
- **Zendure Hyper 2000** Integration (Laden/Entladen)
- **48h EPEX Forecast** mit interaktivem Balkendiagramm
- **Energiefluss-Visualisierung** zwischen den Standorten
- **Anker Solix 1600 AC** Netzladen via `anker_solix.modify_solix_backup_charge`

### Geändert
- Komplett neues Dashboard-Design (dunkel, elegant, ohne Emojis)
- Zwei-Parteien-Architektur (Party1: Anker, Party2: Zendure)
- Verbesserte Trading-Logik mit P2P-Unterstützung
- EPEX Sensor auf `sensor.epex_spot_data_total_price` geändert

### Konfiguration
- Neue Optionen für zwei Standorte (Koordinaten, Namen)
- Zendure-spezifische Entities hinzugefügt
- `p2p_trade_amount_wh` für Trade-Größe

## [2.1.0] - 2026-01-25

### Neu
- Komplette Neuerstellung basierend auf Chat-Anforderungen
- Vollständige Anker Solix 2 Integration via HACS
- EPEX Spot Day-Ahead Preise (48h Forecast)
- Peaq Blockchain Trade Recording
- Web Dashboard mit Live-Status

### Geändert
- **WICHTIG:** `npm install` statt `npm ci` im Dockerfile
  - Behebt den "package-lock.json required" Fehler
  - Verwendet `--omit=dev` statt deprecated `--production`
- Node.js >= 18 erforderlich
- Verbesserte Fehlerbehandlung
- Demo-Modus wenn SDK nicht verfügbar

### Dependencies
- @peaq-network/sdk: ^0.2.0
- @polkadot/api: ^10.11.0
- ethers: ^6.9.2
- express: ^4.18.2
- node-cron: ^3.0.3
- node-fetch: ^3.3.2

## [2.0.0] - 2026-01-22

### Erste Version
- Basis Peaq Integration
- Einfache EPEX Preisanbindung
- Web UI

## [1.0.0] - 2026-01-22

### Initial Release
- Peaq Blockchain Verbindung
- DID Registration
- Basis Web UI
