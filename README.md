# The Electron Chain · ELP-Hub (Home Assistant Addon)

**v5.0.0** — peaq-blockchain-anchored Energy Sharing under §42c EnWG.

This repository ships **two complementary pieces** that together form the
Electron Ledger Protocol (ELP):

| Piece | Role | Lives in |
|---|---|---|
| **ELP-Hub** (this addon) | Order book, matching engine, persistence, REST/WebSocket API, Cooperative Cockpit dashboard | repository root (`Dockerfile`, `config.yaml`, `rootfs/`) |
| **`electron_chain` integration** | One Home Assistant per household — reads adapter, publishes offers via MQTT, signs on peaq, holds the Fernet-encrypted wallet | [HA-integration/custom_components/electron_chain/](HA-integration/custom_components/electron_chain/) (installable via HACS) |

> Until v4.1 the addon was a monolithic Node.js trading daemon. v5.0.0 replaces
> it with a Python Hub that aggregates dozens to hundreds of household nodes.
> See [CHANGELOG.md](CHANGELOG.md) for the full delta.

---

## Architecture

```
┌────────────────────────────────────────────────────────────┐
│ HA Instances · 1 per household                             │
│   custom_components/electron_chain (HACS)                  │
│     ├─ adapters/    Anker · Marstek · Maxxi · Shelly · …   │
│     ├─ wallet_crypto.py   ← Fernet-wrapped seed @ rest     │
│     └─ coordinator.py     ← publishes offers via MQTT      │
└──────────────────┬─────────────────────────────────────────┘
                   │ MQTT  (elp/{coop}/offers, /heartbeat, /match)
┌──────────────────▼─────────────────────────────────────────┐
│ ELP-Hub (this addon)                                       │
│   hub.py        ← 5 async tasks                            │
│   db.py         ← SQLite schema v3 (incl. secrets_vault)   │
│   repositories.py                                          │
│   api.py        ← FastAPI · REST · WebSocket · /v1/vault   │
│   wallet_crypto.py   ← Fernet + PBKDF2-HMAC-SHA256         │
│   dashboard/    ← Cooperative Cockpit (static)             │
└────────────────────────────────────────────────────────────┘
```

---

## Install (addon)

1. Add this repository as a HA addon repository: **Settings → Add-ons → Add-on Store → ⋮ → Repositories**.
2. Install **TheElectronChain** and start it. The Hub listens on `:8099`.
3. Install the Mosquitto addon (HA Supervisor) — the Hub talks to it by default
   at `core-mosquitto:1883`.

### Addon options

| Key | Default | Notes |
|---|---|---|
| `coop_id` | `heutestadtmorgen` | MQTT topic namespace + DB partition |
| `mqtt_host` / `mqtt_port` | `core-mosquitto` / `1883` | Override if you run your own broker |
| `mqtt_username` / `mqtt_password` | empty | Only set if your broker requires auth |
| `match_interval_sec` | `15` | Uniform-price clearing cycle |
| `grid_price_default_ct` | `32.0` | Sinusoidal stand-in for an EPEX feed |
| `heartbeat_prune_sec` | `86400` | Drops raw heartbeats older than this |
| `hub_api_port` | `8099` | Dashboard + REST + WebSocket |

---

## Install (integration on each HA)

Each household runs its own HA instance with the `electron_chain` integration.

1. **HACS → Custom Repository** → `https://github.com/heutestadtmorgen/electron-chain` → category Integration
2. **Settings → Devices & Services → Add Integration → Electron Chain**
3. Three-step wizard:
   1. Identity + RPC + Hub URLs + **wallet seed + passphrase** (seed gets
      Fernet-wrapped before it ever lands on disk)
   2. Adapter pick (auto-detection scans `hass.states`)
   3. Adapter binding confirmation
4. After every HA restart the integration triggers a **reauth flow** asking for
   the wallet passphrase — the plaintext seed never persists.

---

## API

```
GET    /api/health
GET    /v1/cooperatives
GET    /v1/cooperatives/{coop}/households?limit=200&offset=0
GET    /v1/cooperatives/{coop}/orderbook?limit=50
GET    /v1/cooperatives/{coop}/matches/recent?limit=50
GET    /v1/cooperatives/{coop}/aggregate/last-hour
GET    /v1/cooperatives/{coop}/kpis
POST   /v1/households                              # HA integration → Hub registration
WS     /v1/cooperatives/{coop}/live                # init frame + delta stream

GET    /v1/vault                                   # list secret names
POST   /v1/vault/{name}                            # {plaintext, passphrase}
POST   /v1/vault/{name}/unlock                     # {passphrase} → {plaintext}
DELETE /v1/vault/{name}
```

---

## Wallet security

`wallet_crypto.py` exists on **both sides** (addon + integration) with a
byte-identical envelope format:

- KDF: PBKDF2-HMAC-SHA256 · 480 000 iterations · 16-byte random salt
- Sealing: Fernet (AES-128-CBC + HMAC-SHA256, authenticated)
- Verifier blob: lets the API detect a wrong passphrase **before** decrypting
  the actual secret, so neither side becomes a passphrase oracle
- Passphrase never written to disk; lives in process memory only

A seed wrapped by the integration can therefore be unwrapped by the addon and
vice-versa.

---

## Inspecting the live DB

```bash
docker exec -it $(docker ps -qf "name=addon_local_the_electron_chain") \
    sqlite3 /data/elp.sqlite

sqlite> SELECT household_id, adapter_vendor, last_seen_at FROM households;
sqlite> SELECT COUNT(*), AVG(price_ct_per_kwh) FROM offers WHERE status='matched';
sqlite> SELECT coop_id, SUM(kwh), SUM(revenue_ct)/100.0 AS eur
         FROM settlements WHERE settled_at > strftime('%s','now','-1 day')
         GROUP BY coop_id;
```

---

## Scaling

| N households | What changes |
|---|---|
| ≤ 50  | Defaults. Mosquitto, SQLite WAL fine. |
| ≤ 200 | Bump HA-host RAM. Still single-Hub. |
| ≤ 500 | Switch broker to EMQX or Mosquitto-bridge. SQLite WAL still OK. |
| > 500 | Migrate `db.py` to PostgreSQL + TimescaleDB. The `repositories.py` interface stays identical. |

---

## Repo layout

```
the-Electron-Chain/
├── config.yaml              ← HA addon manifest (v5.0.0)
├── Dockerfile               ← Alpine + Python 3.11
├── build.yaml               ← multi-arch base images
├── CHANGELOG.md
├── rootfs/
│   ├── run.sh
│   └── app/
│       ├── hub.py           ← 5 async tasks: MQTT, match, price, prune, API
│       ├── api.py           ← FastAPI + WebSocket + vault endpoints
│       ├── db.py            ← SQLite schema v3
│       ├── repositories.py
│       ├── wallet_crypto.py ← Fernet + PBKDF2
│       └── dashboard/       ← Cooperative Cockpit (static)
└── HA-integration/          ← HACS-installable integration (one per household)
    ├── custom_components/electron_chain/
    │   ├── __init__.py
    │   ├── config_flow.py        ← wizard + reauth (passphrase prompt)
    │   ├── wallet_crypto.py
    │   ├── adapters/             ← Anker, Marstek, Maxxi, Shelly, generic
    │   └── …
    ├── elp-hub/                  ← reference docker-compose Hub (legacy)
    └── dashboard/                ← source of truth for /app/dashboard
```

---

## Known limits (still v5.0)

| Area | Status |
|---|---|
| peaq pallet names | `PeaqStorage::add_item` first, fallback `PeaqDid::add_attribute` — verify against current Agung runtime metadata |
| MQTT auth | If your broker requires it, set `mqtt_username`/`mqtt_password` in addon options. Anonymous on the HA-internal bridge is fine in most setups. |
| Order book recovery | SQLite WAL persists across restarts, but an in-flight clearing cycle can lose un-matched offers if the Hub is killed mid-cycle |
| §42c regulatory | Hub clearings are informational; production §42c needs real GPKE / MaBiS plumbing |
| HACS publishing | Add `hacs.json` once the integration shape stabilises |

---

## License

Apache-2.0
