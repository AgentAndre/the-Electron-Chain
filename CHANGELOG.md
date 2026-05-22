# Changelog

## [5.0.0] - 2026-05-22

### Architektur — Konversion HA-Integration → Python-Addon

Das Main-Folder Addon ist jetzt der **ELP-Hub** (Electron Ledger Protocol). Der
bisherige monolithische Node.js Trading-Daemon (v4.1.0, `rootfs/app/index.js`)
wurde komplett entfernt. Das Addon hostet jetzt die Aggregations- und
Matching-Schicht für eine §42c-Genossenschaft, während jede HA-Instanz die
HACS-Integration aus `HA-integration/` als Household-Node fährt.

### Neu

- **Python-Stack** statt Node.js: FastAPI + uvicorn + aiomqtt + aiosqlite
- **Order Book & Matching-Engine** — uniform-price clearing alle 15 s (konfigurierbar)
- **SQLite-Persistenz** im /data-Volume mit WAL-Modus und Schema-Versioning
  (v3 fügt `secrets_vault` für Fernet-Secrets hinzu)
- **Cooperative Cockpit Dashboard** auf Port 8099 mit virtualisiertem Household-Grid,
  Canvas-Chart, Order-Book und Match-Stream — server-aggregierte Deltas via WebSocket
- **REST-API** `/v1/cooperatives/...` für Drittsysteme + Health-Check `/api/health`
- **Fernet-Wallet-Vault** (`/v1/vault`): PBKDF2-HMAC-SHA256 (480k Iterationen) +
  Fernet-Wrapper, mit Verifier-Blob gegen Passphrase-Oracle
- **Grid-Price-Oracle** als MQTT-Retain-Topic `elp/{coop}/grid/price`
- **Heartbeat-Pruning** automatisch nach `heartbeat_prune_sec` (Default 24 h)

### Geändert

- `config.yaml` schlank getrimmt auf Hub-Settings — Household-spezifische Optionen
  (Wallet, Adapter, SMGw, PV-Geometrie) liegen jetzt in der HA-Integration
- Dockerfile auf Alpine + Python 3.11; cryptography, FastAPI, uvicorn, aiomqtt
  als gepinnte Wheels; Build-Deps werden nach `pip install` weggeräumt
- Healthcheck zielt jetzt auf `/api/health` (FastAPI)
- MQTT-Service-Anforderung verschärft: `mqtt:need` (vorher `mqtt:want`)

### HACS-Integration (`HA-integration/custom_components/electron_chain` v0.3.0)

- **Verschlüsselter Wallet-Seed**: Im Config-Flow wird der Seed mit einer
  User-Passphrase per Fernet eingewickelt; nur das Chiffrat landet im
  Config-Entry (`wallet_seed_enc`)
- **Reauth-Flow** nach jedem HA-Restart, der die Passphrase abfragt, den Seed
  in-memory cached (`hass.data[DOMAIN]['_seeds']`) und ihn beim Unload wieder
  wegwischt
- Manifest: neue Requirement `cryptography>=42.0.0`

### Entfernt

- `package.json`, `rootfs/app/index.js` (3632 Zeilen Node.js)
- `@peaq-network/sdk`, `@polkadot/api`, `ethers`, `express`, `ws`, `dotenv`,
  `node-cron`, `node-fetch` (Node-Deps)

### Migration

`/data/elp.sqlite` wird beim ersten Start automatisch angelegt. Bestehende
Node-State-Files unter `/data/` werden nicht angerührt — können aber manuell
entfernt werden, sobald der Hub stabil läuft.

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
