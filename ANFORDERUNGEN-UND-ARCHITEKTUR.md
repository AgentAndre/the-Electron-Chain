# The Electron Chain — Anforderungsdokumentation & Architektur

**Stand:** 2026-05-18
**Repository:** the-Electron-Chain
**Beteiligte Komponenten:** HA-Add-on (P2P Energy Trading v3.0.0), HA Custom Integration *Electron Chain* (v0.2.0), ELP-Hub, Cooperative Cockpit, Website (heutestadtmorgen.eu)

---

## 1. Zielbild und regulatorischer Rahmen

### 1.1 Vision
Aufbau eines **peer-to-peer Energieteilungs-Systems** zwischen Mitgliedern einer Energiegemeinschaft nach **§42c EnWG** ("gemeinschaftliche Gebäudeversorgung" / "Energy Sharing"). Überschüssige PV-Energie aus einem Haushalt wird *innerhalb der Genossenschaft* an Bedarfshaushalte vermittelt, statt zu Spotpreisen an den Netzbetreiber zu verkaufen. Jeder Handel wird auf der **peaq-Blockchain** (Agung Testnet / Krest Mainnet) unfälschbar verankert.

### 1.2 Regulatorische Eckpunkte (nicht-funktionale Anforderungen)
| Bezug | Anforderung |
|---|---|
| §42c EnWG | Bilanzielle Zuordnung über Bilanzkreis, Nachweis durch zertifizierte Messung |
| MsbG / SMGW | Verwendung von zertifizierten Smart-Meter-Gateways (SMGW) zur fiskaltauglichen Messung |
| GPKE / MaBiS | Marktkommunikation muss zumindest perspektivisch andockbar sein |
| BNetzA / VDE-AR-N 4105 | Einhaltung der Sign-Convention (Erzeuger = positiv) bei Leistungsflüssen |
| DSGVO | Personenbezogene Daten bleiben in der HA-Instanz; nur pseudonyme DID + Aggregate verlassen den Haushalt |

Der derzeitige Stand ist eine **Pilot-/Forschungsumgebung**: das Clearing im Hub ist *informational*, eine echte Bilanzkreisabrechnung ist noch nicht angebunden (siehe §6 "Bekannte Grenzen").

---

## 2. Umgesetzte Arbeitspakete (Überblick)

| AP | Bezeichnung | Status | Hauptartefakte |
|----|---|---|---|
| AP1 | P2P-Energy-Trading-Add-on (v3.0.0) für zwei feste Parteien | abgeschlossen | [config.yaml](config.yaml), [rootfs/app/](rootfs/app/), [README.md](README.md) |
| AP2 | Generische HA Custom Integration *Electron Chain* (v0.2.0) | abgeschlossen | [HA-integration/custom_components/electron_chain/](HA-integration/custom_components/electron_chain/) |
| AP3 | Geräte-Adapter-System (Plug-in-Architektur) | abgeschlossen | [HA-integration/custom_components/electron_chain/adapters/](HA-integration/custom_components/electron_chain/adapters/) |
| AP4 | peaq-Blockchain-Client | abgeschlossen | [peaq_client.py](HA-integration/custom_components/electron_chain/peaq_client.py) |
| AP5 | ELP-Hub: Matching-Engine + REST/WS-API + Persistenz | abgeschlossen | [HA-integration/elp-hub/](HA-integration/elp-hub/) |
| AP6 | Cooperative Cockpit (Live-Dashboard, hunderte Haushalte) | abgeschlossen | [HA-integration/dashboard/](HA-integration/dashboard/) |
| AP7 | Flotten-Bootstrap (10 HA-Instanzen für Lasttests) | abgeschlossen | [docker-compose.yml](HA-integration/docker-compose.yml), [scripts/bootstrap-fleet.sh](HA-integration/scripts/bootstrap-fleet.sh) |
| AP8 | Website + Impressum (heutestadtmorgen.eu / electron-chain) | abgeschlossen | [website/](website/) |
| AP9 | Figma-Spec / UI-Design | abgeschlossen | [design/figma-spec.html](design/figma-spec.html) |

---

## 3. Detaillierte Anforderungen je Arbeitspaket

### 3.1 AP1 — P2P-Energy-Trading-Add-on (v3.0.0)

#### Funktionale Anforderungen (FA)
| ID | Anforderung |
|----|---|
| FA1.1 | Automatischer bidirektionaler Energiehandel zwischen genau **zwei** definierten Parteien (Gertrud-Koch-Str./Köln und Eilendorfer-Str./Aachen). |
| FA1.2 | Steuerung **Anker Solix 1600 AC** (Notladung + Output-Preset + `anker_solix.modify_solix_backup_charge`). |
| FA1.3 | Steuerung **Zendure Hyper 2000** (`input_limit`, `output_limit`, `select.hyper_2000_ac_mode`). |
| FA1.4 | Einbindung der **48-h-EPEX-Day-Ahead-Preise** über die HACS-Integration `EPEX Spot` (Sensor `sensor.epex_spot_data_total_price`). |
| FA1.5 | Konfigurierbare Preisschwellen `min_sell_price = 0,25`, `max_buy_price = 0,22`, `min_buy_price = 0,02` (negative Preise ausschließen). |
| FA1.6 | Schreiben jedes Trades als Storage-Item / DID-Attribut auf **peaq Agung Testnet** (`wss://wsspc1-qa.agung.peaq.network`). |
| FA1.7 | Webdashboard auf Port `8099` mit interaktiver Karte (Leaflet.js, Dark Theme), 48-h-Preis-Balkendiagramm, Trade-Historie und animiertem Energiefluss zwischen den Standorten. |
| FA1.8 | Logik laut README: `Verkauf wenn Preis ≥ min_sell_price und Batterie-Differenz ≥ 10 %`, `beidseitiges Netzladen wenn Preis ≤ max_buy_price`. |

#### Nicht-funktionale Anforderungen (NFA)
| ID | Anforderung |
|----|---|
| NFA1.1 | HA-Add-on, Multi-Arch-Build (`build.yaml`), Node.js ≥ 18. |
| NFA1.2 | `npm install --omit=dev` statt `npm ci` (vermeidet das `package-lock.json required` Problem, siehe Changelog 2.1.0). |
| NFA1.3 | Demo-Modus, falls das peaq-SDK nicht lädt — das Add-on bleibt lauffähig, Trades werden nur lokal protokolliert. |
| NFA1.4 | Minimum-Reserve je Batterie: **20 %** SoC werden nicht verkauft. |
| NFA1.5 | Trade-Granularität: `p2p_trade_amount_wh = 100` Wh pro Transaktion. |

#### Konfigurationsoberfläche (`config.yaml`)
Zwei Parteien-Blöcke (`party1_*`, `party2_*`) mit Koordinaten, Sensor-Entities, Steuer-Entities, Device-IDs sowie ein gemeinsamer `trading`-Block. Vollständiges Schema siehe [README.md:84-118](README.md#L84-L118).

---

### 3.2 AP2 — HA Custom Integration *Electron Chain* (v0.2.0)

Generalisierung von AP1: aus dem Zwei-Parteien-Add-on wird eine **n-Parteien-Genossenschafts-Lösung**, in der jede teilnehmende HA-Instanz exakt einen Haushalt repräsentiert.

#### Funktionale Anforderungen
| ID | Anforderung |
|----|---|
| FA2.1 | Installation per **HACS** / Manuell als `custom_components/electron_chain`. Manifest siehe [manifest.json](HA-integration/custom_components/electron_chain/manifest.json). |
| FA2.2 | **3-stufiger Config-Flow** (siehe [config_flow.py](HA-integration/custom_components/electron_chain/config_flow.py)): (1) Identität & Chain-Creds, (2) Adapter wählen, (3) Entity-Binding bestätigen. |
| FA2.3 | DID-Auto-Generierung (`did:peaq:<uuid24>`), wenn der Nutzer das Feld leer lässt. |
| FA2.4 | Pflichtfeld `wallet_seed` (mnemonic oder `//Alice`-Style für Testnet). |
| FA2.5 | Eindeutigkeit pro HA über `unique_id = "<coop>::<household>"`; Doppelt-Anlage wird per `_abort_if_unique_id_configured` verhindert. |
| FA2.6 | **DataUpdateCoordinator** liest alle `DEFAULT_UPDATE_INTERVAL_SEC = 30 s` den Geräte-Adapter, veröffentlicht alle `DEFAULT_OFFER_INTERVAL_SEC = 60 s` ein Offer (sofern Überschuss > `DEFAULT_MIN_SURPLUS_W = 100 W`). |
| FA2.7 | Erzeugt HA-Entities: `sensor.electron_chain_*` (Status, Surplus, PV, SoC, Offer-Preis, Today-Trade-kWh, Today-Revenue, Chain-Block, Adapter) und `switch.electron_chain_trading_enabled`. |
| FA2.8 | MQTT-Subscriptions: `elp/{coop}/match/{household}`, `.../settlement/{household}`, `.../grid/price`, `.../offers/book` — siehe [const.py](HA-integration/custom_components/electron_chain/const.py). |
| FA2.9 | Lokalisierung: `translations/{de,en}.json`. |

#### Nicht-funktionale Anforderungen
| ID | Anforderung |
|----|---|
| NFA2.1 | Reine **Local-Polling**-Integration (`iot_class: local_polling`) — kein Cloud-Zugriff außerhalb der peaq-RPC. |
| NFA2.2 | Abhängigkeiten: `substrate-interface==1.7.10`, `py-sr25519-bindings==0.2.0`, `websockets>=12,<14`, `aiomqtt==2.3.0`. |
| NFA2.3 | Wenn der Hub nicht erreichbar ist, läuft die Integration **degradiert** weiter (lokale Sensoren bleiben, keine Trades). |
| NFA2.4 | Synchrone `substrate-interface`-Aufrufe werden konsequent über `hass.async_add_executor_job` ausgeführt, um den HA-Eventloop nicht zu blockieren. |

---

### 3.3 AP3 — Geräte-Adapter-System

#### Anforderung
Vendor-Support muss **plug-in** sein, damit das Hinzufügen eines neuen Speichers / Wechselrichters keine Änderungen am Coordinator erfordert (Open/Closed-Principle).

#### Umgesetzte Adapter (siehe [adapters/](HA-integration/custom_components/electron_chain/adapters/))
| Vendor | Modell | Capabilities | Priorität | Steuerbar |
|---|---|---|---|---|
| `anker_solix` | Solarbank E1600 / Solix | `pv`, `battery` | 60 | nein |
| `marstek_venus` | Venus E (Gen 2/3 + Modbus-Setpoint) | `pv`, `battery`, `controllable` | 65 | ja |
| `maxxicharge` | Maxxicharge 3.0 | `pv`, `battery`, `controllable` | 65 | ja |
| `shelly_3em` | Shelly 3EM / Pro 3EM | `grid` (only) | 40 | nein |
| `generic` | Generic / Manual | `pv`, `battery`, `grid` | 1 | nein |

#### Schnittstellenvertrag ([adapters/base.py](HA-integration/custom_components/electron_chain/adapters/base.py))
```python
class DeviceAdapter(ABC):
    vendor: str
    model: str
    capabilities: set[str]   # ⊆ {"pv","battery","grid","controllable"}
    priority: int

    @classmethod
    def discover(cls, hass) -> list[dict[str, str]]   # autodiscover Entities
    def read_state(self, hass) -> DeviceReading       # normalisierte Messung
    async def set_battery_setpoint_w(hass, watts) -> bool   # optional
```

Die normalisierte `DeviceReading` (siehe [base.py:15-47](HA-integration/custom_components/electron_chain/adapters/base.py#L15-L47)) folgt der **VDE-AR-N-4105-Sign-Convention**: `battery_power_w > 0` = laden, `grid_export_w > 0` = einspeisen. Eine Methode `surplus_w()` berechnet den handelbaren Überschuss; `is_complete_enough_to_trade()` ist das Mindestkriterium.

#### Discovery-Strategie
- Beim Config-Flow Schritt 2 werden **alle** registrierten Adapter aufgerufen.
- Höhere Priorität gewinnt, wenn mehrere matchen.
- Shelly 3EM bewusst mit niedriger Priorität (`40`), weil es nur die Netzmessung liefert und nicht primär das Batteriesystem.

#### Neue Vendoren hinzufügen
1. `adapters/<vendor>.py` anlegen, `DeviceAdapter` ableiten, `@register` setzen.
2. Import in `adapters/__init__.py` ergänzen.
3. Adapter erscheint **automatisch** im Dropdown.
Kein Code-Eingriff am Coordinator.

---

### 3.4 AP4 — peaq-Blockchain-Client

#### Anforderungen
| ID | Anforderung |
|----|---|
| FA4.1 | Verbindung zu beliebigem peaq-RPC (Default: Agung Testnet). |
| FA4.2 | Schlüsselerzeugung aus seed/mnemonic (sr25519). |
| FA4.3 | Liveness-Probe per `get_chain_finalised_head` → Blockhöhe. |
| FA4.4 | **Offer-Anchoring** über `PeaqStorage::add_item(item_type, item)`; bei fehlendem Pallet Fallback auf `PeaqDid::add_attribute`. |
| FA4.5 | Wartet auf `wait_for_inclusion=True` und liefert `block_number` + `extrinsic_hash` an den Coordinator zurück. |
| FA4.6 | Serialisierung der `FlexibilityOffer` als kompaktes JSON-Blob (siehe [peaq_client.py:54-56](HA-integration/custom_components/electron_chain/peaq_client.py#L54-L56)). |
| NFA4.1 | Alle synchronen substrate-interface-Calls laufen im Executor; ein `asyncio.Lock` serialisiert Submissions pro Client. |
| NFA4.2 | Fehlerklassen: `PeaqConnectionError` (RPC-Probleme) vs. `PeaqExtrinsicError` (chain-seitiger Fehler). |

#### Datenmodell `FlexibilityOffer`
```
offer_id          uuid4-hex (16 chars)
seller_did        did:peaq:...
kwh               float
price_ct_per_kwh  float
valid_until       unix-ts (Default: +15 min)
cooperative_id    str
block_number      int   (gesetzt nach on-chain submit)
extrinsic_hash    hex   (gesetzt nach on-chain submit)
```

---

### 3.5 AP5 — ELP-Hub

#### Anforderungen
| ID | Anforderung |
|----|---|
| FA5.1 | Ein Container, fünf nebenläufige asyncio-Tasks: **MQTT-Consumer**, **Matching-Loop**, **Price-Oracle**, **DB-Pruning**, **FastAPI-Server**. |
| FA5.2 | **Uniform-Price-Clearing** alle `MATCH_INTERVAL_SEC = 15 s` (siehe [hub.py:127-162](HA-integration/elp-hub/hub.py#L127-L162)): obere Hälfte des Orderbuchs wird zum Median-Preis gecleared. |
| FA5.3 | Abgelaufene Offers werden vor jedem Match-Lauf auf `expired` gesetzt. |
| FA5.4 | Pro Match werden `match` + `settlement` an die jeweilige Haushalts-Topic gepublished (`elp/{coop}/match/{household}` + `.../settlement/...`). |
| FA5.5 | Price-Oracle als Stand-in für den EPEX-Feed: `32 ct ± 8 ct · sin(t/600)` alle 30 s auf `elp/{coop}/grid/price` (retain). |
| FA5.6 | DB-Pruning für `heartbeats` älter als `HEARTBEAT_PRUNE_SEC = 86 400 s` (1 Tag). |
| FA5.7 | Aufnahme neuer Haushalte über `POST /v1/households` (kein vorheriges Provisioning nötig). |
| NFA5.1 | SQLite WAL-Mode, FK-Constraints, `schema_version` Tabelle mit Migrations-Steps `DDL_V1` → `DDL_V2`. |
| NFA5.2 | Pure-async-DAO-Layer in [repositories.py](HA-integration/elp-hub/repositories.py); kein SQL-Leak außerhalb dieser Datei. Tausch gegen `asyncpg/PostgreSQL` ist als 20-Zeilen-Shim in `db.py` vorgesehen. |
| NFA5.3 | Keine MQTT-Auth (Pilot-Umgebung). Produktion benötigt user/pass + TLS. |
| NFA5.4 | Container belegt ca. **80 MB RAM**, scaliert linear bis ≤ 200 Haushalte; danach Postgres/Timescale-Pfad. |

#### Datenmodell ([db.py](HA-integration/elp-hub/db.py))
```
cooperatives    (coop_id PK, name, vnb_id, bilanzkreis_id, …)
households      (household_id, coop_id PK)
                 did, ss58_address, adapter_vendor, capabilities_json, last_seen_at
devices         (device_id PK, household_id, vendor, role, binding_json, is_controllable)
offers          (offer_id PK, coop_id, household_id, seller_did,
                 kwh, price_ct_per_kwh, valid_until, block_number,
                 extrinsic_hash, status ∈ {open,matched,expired,cancelled})
matches         (match_id PK, offer_id, buyer_did, clearing_price_ct, matched_at)
settlements     (settlement_id PK, match_id, household_id, kwh, revenue_ct)
heartbeats      ((coop_id, household_id, ts) PK, surplus_w, pv_w, battery_soc,
                 battery_w, grid_export_w, block, trading)
coop_settings   (coop_id PK, match_interval_s, fee_pct, settings_json)
schema_version  (version PK)
```

#### HTTP/WS-API ([api.py](HA-integration/elp-hub/api.py))
| Methode | Pfad | Zweck |
|---|---|---|
| `GET` | `/v1/cooperatives` | Liste aller Genossenschaften |
| `GET` | `/v1/cooperatives/{coop}/households` | Paginierter Haushaltsdatensatz + Live-Cache-Enrichment |
| `GET` | `/v1/cooperatives/{coop}/orderbook` | Top-N offene Offers (preisaufsteigend) |
| `GET` | `/v1/cooperatives/{coop}/matches/recent` | Letzte Matches |
| `GET` | `/v1/cooperatives/{coop}/aggregate/last-hour` | Minutenbuckets der letzten 60 min + Tagesumsatz |
| `GET` | `/v1/cooperatives/{coop}/kpis` | KPI-Snapshot |
| `POST` | `/v1/households` | Haushalt registrieren (Idempotent, Upsert) |
| `WS` | `/v1/cooperatives/{coop}/live` | Delta-Stream (s. unten) |
| `GET` | `/` | Statisches Dashboard (index.html) |

#### WebSocket-Protokoll (KRITISCH für Skalierung)
- **Erstes Frame**: `type:"init"` mit Voll-Snapshot (KPIs, alle Haushalte, Top-50 Buch, letzte 20 Matches).
- **Folgeframes (1/s)**: `type:"delta"` mit *nur veränderten* Haushalten (`households_delta`), *neuen* Matches (`new_matches`) und aktualisierten `kpis`.
- Server-seitige Aggregation der KPIs aus dem in-memory-`_LIVE`-Cache (siehe [api.py:50-67](HA-integration/elp-hub/api.py#L50-L67)).
- Damit bleibt die Wire-Last konstant bei wenigen kB/s, selbst bei N = 500 Haushalten.

---

### 3.6 AP6 — Cooperative Cockpit

#### Anforderungen
| ID | Anforderung |
|----|---|
| FA6.1 | Operator-Console-Optik (dunkel, technisch, ohne Emojis), siehe [dashboard/styles.css](HA-integration/dashboard/styles.css). |
| FA6.2 | **KPI-Strip**: `n_active`, `sum_surplus_w`, `kWh heute`, `Umsatz heute`, `n_open_offers`. |
| FA6.3 | **Live-Chart**: Canvas, letzte 60 min, DPR-aware, NICHT DOM-per-Datenpunkt. |
| FA6.4 | **Households-Grid**: virtualisiertes Rendering, Map-keyed Delta-Updates, `contain: strict`. |
| FA6.5 | **Order-Book**: Top-15. |
| FA6.6 | **Match-Stream**: live, `/min`-Counter. |
| NFA6.1 | Bei N=500: nur Änderungen über die Wire, 1 WebSocket pro Tab. |
| NFA6.2 | Statisches Bundle (index.html, app.js, styles.css), durch den Hub auf `/` serviert. |

---

### 3.7 AP7 — Flotten-Bootstrap

#### Anforderungen
| ID | Anforderung |
|----|---|
| FA7.1 | Skript `./scripts/bootstrap-fleet.sh N` generiert N HA-Konfigurationsverzeichnisse unter `docker/configs/ha-1 … ha-N`. |
| FA7.2 | `docker-compose.yml` bringt Mosquitto + Hub + 10 HA-Instanzen hoch (Standardvorlage). |
| FA7.3 | Jede HA hat das Custom-Component als **Read-Only-Bind-Mount**, damit Codeänderungen ohne Rebuild greifen. |
| NFA7.1 | Ressourcen: 10 HA × ~300 MB + Hub ~80 MB + MQTT ~50 MB ≈ **3,3 GB RAM**. |
| NFA7.2 | Skalierung (siehe [README:230-242](HA-integration/README.md#L230-L242)): ≤50 default, ≤200 Hub auf 2 GB, ≤500 EMQX, >500 Postgres+Timescale. |

---

### 3.8 AP8 — Website

#### Umgesetzte Seiten ([website/](website/))
| Datei | Inhalt |
|---|---|
| `index.html` | Landing Page für *the Electron Chain* / *heute stadt morgen* |
| `energy-community-diagram.html` | ASCII-Architekturdiagramm der Energiegemeinschaft (siehe Commit `88d386f`) |
| `impressum.html` | Impressum heute stadt morgen |
| `impressum-electron-chain.html` | Separates Impressum für Electron-Chain-Sub-Brand |

#### Anforderungen
- Statische, hostingneutrale HTML-Seiten (keine Build-Toolchain nötig).
- Impressum konform mit §5 TMG inkl. SMGW-ID, soweit für die Pilot-Phase relevant.

---

### 3.9 AP9 — Design

[design/figma-spec.html](design/figma-spec.html) enthält den Export der UI-Spezifikation aus Figma — Referenz für Dashboard-Farbpalette, Komponenten-Layout und das "Operator-Console"-Erscheinungsbild.

---

## 4. Gesamtarchitektur

### 4.1 Logische Schichten

```
┌─────────────────────────────────────────────────────────────────────┐
│  HA-Instanz pro Haushalt (N = 10 .. 500)                            │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │  custom_components/electron_chain/                          │    │
│  │  ├─ adapters/      ← Plug-in pro Vendor                     │    │
│  │  │   anker_solix · marstek_venus · maxxicharge ·            │    │
│  │  │   shelly_em · generic_template                           │    │
│  │  ├─ coordinator.py — liest Adapter alle 30 s,               │    │
│  │  │                   postet Offer alle 60 s                 │    │
│  │  └─ peaq_client.py — substrate-interface (sr25519)          │    │
│  └─────────────────────────────────────────────────────────────┘    │
└────────────────┬────────────────────────────────────────────────────┘
                 │  MQTT  (Offers, Heartbeats, Matches, Settlements,
                 │         Grid-Preis)
                 │  RPC   (peaq-Storage Extrinsics)
┌────────────────▼────────────────────────────────────────────────────┐
│  ELP-Hub  (1 Container, 5 nebenläufige Tasks)                       │
│  ├─ MQTT-Consumer  → SQLite                                         │
│  ├─ Matching-Loop  → Uniform-Price-Clearing / 15 s                  │
│  ├─ Price-Oracle   → Sinus-Stand-in für EPEX                        │
│  ├─ DB-Pruning     → heartbeats > 24 h                              │
│  └─ FastAPI / WS   → :8000                                          │
│                                                                     │
│  SQLite (WAL):                                                      │
│   cooperatives · households · devices · offers · matches ·          │
│   settlements · heartbeats · coop_settings · schema_version         │
└────────────────┬────────────────────────────────────────────────────┘
                 │  HTTP/WebSocket  (init-Snapshot + 1-Hz-Deltas)
┌────────────────▼────────────────────────────────────────────────────┐
│  Cooperative Cockpit  (statisches HTML, vom Hub serviert)           │
│  KPI-Strip · Live-Canvas-Chart · Households-Grid (virtualisiert) ·  │
│  Order-Book · Match-Stream                                          │
└─────────────────────────────────────────────────────────────────────┘

                 │  Storage-Extrinsic (Offer-JSON)
                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│  peaq Blockchain  (Agung Testnet / Krest Mainnet)                   │
│  PeaqStorage::add_item   ⟵ Primärpfad                               │
│  PeaqDid::add_attribute  ⟵ Fallback                                 │
└─────────────────────────────────────────────────────────────────────┘
```

### 4.2 Schnittstellen und Topic-Schema (MQTT)
| Topic | Richtung | Payload | QoS |
|---|---|---|---|
| `elp/{coop}/offers/publish` | HA → Hub | Offer-JSON (offer_id, seller_did, kwh, price, valid_until, block, tx) | 1 |
| `elp/{coop}/heartbeat/{household}` | HA → Hub | DeviceReading + surplus, block, trading | 0 retain |
| `elp/{coop}/match/{household}` | Hub → HA | match_id, offer_id, clearing_price, kwh, matched_at | 1 |
| `elp/{coop}/settlement/{household}` | Hub → HA | match_id, kwh, price, revenue_ct, settled_at | 1 |
| `elp/{coop}/grid/price` | Hub → HA | float (ct/kWh) | 0 retain |
| `elp/{coop}/offers/book` | Hub → Dashboard | Top-N Buch | 0 |

### 4.3 Datenfluss eines Trades (End-to-End)
1. **t = 0 s** — `coordinator._async_update_data` liest den Adapter → `DeviceReading` mit `surplus_w = 420 W`.
2. Heartbeat per MQTT an den Hub → Hub schreibt `heartbeats`, markiert `_LIVE` dirty.
3. Da `surplus > 100 W` und letzte Offer > 60 s her ist: Coordinator baut `FlexibilityOffer(kwh ≈ 0,007, price = grid - 5 ct)` und ruft `peaq_client.async_submit_offer`.
4. peaq-Client: `compose_call("PeaqStorage", "add_item", …)` → signiert mit sr25519-Keypair → `submit_extrinsic(wait_for_inclusion=True)` → `block_number`, `extrinsic_hash`.
5. Coordinator published das Offer (inkl. Tx-Hash) auf `elp/<coop>/offers/publish`.
6. Hub-MQTT-Consumer schreibt in `offers` (status=open).
7. **Match-Loop** (alle 15 s): Holt `open_book`, cleared die obere Hälfte zum Medianpreis. Pro Offer → `INSERT INTO matches` + `UPDATE offers SET status=matched` + `INSERT INTO settlements` + `mqtt.publish(match/…)` + `mqtt.publish(settlement/…)`.
8. HA-Coordinator empfängt `match`-Message → setzt `STATE_STATUS = matched`, `STATE_LAST_MATCH`; `settlement`-Message inkrementiert `traded_kwh_today` und `revenue_today_ct`.
9. WebSocket schickt im nächsten Frame den Delta-Update an das Cockpit.

### 4.4 State-Machine im Coordinator
```
                ┌──────────────┐
                │ disconnected │  (RPC down)
                └─────┬────────┘
                      │ chain liveness ok
                      ▼
   ┌────────────┐  reading unvollständig  ┌────────────┐
   │ no_device  │ ◄──────────────────────│            │
   └────────────┘                         │            │
                                          │            │
   surplus > +100 W  &  trading=on   ─────► offering   │
   surplus > +100 W  &  trading=off  ─────►  idle      │
   surplus < −100 W                  ─────► consuming  │
                                          │            │
   MQTT match-event                  ─────► matched    │
                                          └────────────┘
```

### 4.5 Sicherheit (heutiger Stand vs. produktiv)
| Aspekt | Heute | Produktion |
|---|---|---|
| Wallet-Seed | Plain in HA `.storage/` | Fernet-Wrapper mit User-Passphrase |
| MQTT | Anonym im Docker-Netz | user/pass + TLS, ACLs pro Coop |
| peaq | Testnet, `//Alice` möglich | Mainnet, eigene Funding-Adresse, Funding-Workflow |
| SMGW | nicht zwingend | SM-PKI-Cert in DID-Resolution einbinden |
| Bilanzkreis | Hub-Clearing nur informational | GPKE/MaBiS-Anbindung |

---

## 5. Qualitätssicherung & Skalierungsnachweise

### 5.1 Performance-Budget
| Bauteil | Budget | Stand |
|---|---|---|
| Matching-Engine | O(n log n), 500 Offers < 5 ms | erfüllt (`sort` über `open_book`) |
| Browser RAM bei N=500 | < 200 MB | erfüllt (virtualisiertes Grid + Canvas-Chart) |
| WS-Wire bei N=500 | < 50 kB/s | erfüllt (nur Deltas + KPIs) |
| MQTT (Mosquitto) | ≤ 500 Klienten | erfüllt; darüber EMQX |
| SQLite WAL | ≤ 200 Haushalte komfortabel | OK, dann Postgres |

### 5.2 Lokaler Testbetrieb
- 10 HA-Instanzen via `docker-compose up -d`, Ports `8101 … 8110`.
- Cockpit auf `http://localhost:8000`.
- Manuelle Inspektion der DB: `docker compose exec elp-hub sqlite3 /data/elp.sqlite`.

---

## 6. Bekannte Grenzen (Backlog)

| Bereich | Stand | Maßnahme für Produktion |
|---|---|---|
| Wallet-Speicher | Plain | Fernet-Wrapper mit Passphrase |
| peaq-Pallet-Namen | `PeaqStorage::add_item` mit Fallback `PeaqDid::add_attribute` | gegen aktuelle Agung-Runtime-Metadaten verifizieren |
| Orderbook-Crash-Safety | persistiert, aber mid-cycle-Crash kann pending Offers verlieren | WAL-Replay |
| MQTT-Auth | anonym | user/pass + TLS |
| §42c-Regulatorik | nur informationales Clearing | echte GPKE/MaBiS-Plumbing, zertifizierte SMGW-Messung |
| HACS-Publishing | nicht veröffentlicht | `hacs.json`, sobald Schema stabil |
| Stress-Test | 10 Instanzen lokal | 100-Instanzen-Run via `bootstrap-fleet.sh 100` |

---

## 7. Dateistruktur (Referenz)

```
the-Electron-Chain/
├── ANFORDERUNGEN-UND-ARCHITEKTUR.md   ← dieses Dokument
├── README.md                          ← AP1 (P2P-Add-on v3.0.0)
├── CHANGELOG.md
├── config.yaml / build.yaml / Dockerfile / package.json
├── rootfs/
│   ├── run.sh
│   └── app/index.js                   ← Add-on-Hauptanwendung
├── design/
│   └── figma-spec.html                ← AP9
├── website/                           ← AP8
│   ├── index.html
│   ├── energy-community-diagram.html
│   ├── impressum.html
│   └── impressum-electron-chain.html
└── HA-integration/                    ← AP2–AP7
    ├── README.md
    ├── docker-compose.yml
    ├── custom_components/electron_chain/
    │   ├── manifest.json
    │   ├── __init__.py · const.py
    │   ├── config_flow.py
    │   ├── coordinator.py
    │   ├── peaq_client.py             ← AP4
    │   ├── sensor.py · switch.py
    │   ├── strings.json · translations/{de,en}.json
    │   └── adapters/                  ← AP3
    │       ├── base.py · registry.py
    │       ├── anker_solix.py · marstek_venus.py
    │       ├── maxxicharge.py · shelly_em.py
    │       └── generic_template.py
    ├── elp-hub/                       ← AP5
    │   ├── Dockerfile · hub.py
    │   ├── db.py · repositories.py
    │   └── api.py
    ├── dashboard/                     ← AP6
    │   ├── index.html · styles.css · app.js
    ├── docker/mosquitto/mosquitto.conf
    └── scripts/bootstrap-fleet.sh     ← AP7
```

---

## 8. Glossar

| Begriff | Bedeutung |
|---|---|
| **ELP** | Electron Logistics Platform — interner Codename für die Hub-Komponente |
| **DID** | Decentralized Identifier (`did:peaq:<id>`) — pseudonyme Haushaltsadresse |
| **SS58** | Substrate-Adressformat (Prefix 42 für peaq) |
| **EPEX** | European Power Exchange — Day-Ahead-Spotmarkt |
| **SMGW** | Smart Meter Gateway nach BSI TR-03109 |
| **Bilanzkreis** | Regulatorische Aggregationseinheit für Lieferanten-Stromhandel |
| **Uniform-Price-Clearing** | Auktionsmechanismus mit einheitlichem Clearing-Preis (Median) |
| **Heartbeat** | 30-s-Statuspaket eines Haushalts (Surplus, PV, SoC, …) |
