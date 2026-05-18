"""SQLite schema for the ELP-Hub.

Single-file DB at $ELP_DB_PATH (default /data/elp.sqlite). Designed for
low-friction local persistence; swap for Postgres+TimescaleDB when scaling
beyond ~200 households (the access pattern is identical via aiosqlite/asyncpg).

Schema versioning is tracked in `schema_version` so migrations stay simple.
"""
from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager
from typing import AsyncIterator

import aiosqlite

_LOGGER = logging.getLogger(__name__)

DB_PATH = os.environ.get("ELP_DB_PATH", "/data/elp.sqlite")
SCHEMA_VERSION = 2

DDL_V1 = """
CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS cooperatives (
    coop_id           TEXT PRIMARY KEY,
    name              TEXT NOT NULL,
    vnb_id            TEXT,
    bilanzkreis_id    TEXT,
    created_at        INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
    metadata_json     TEXT
);

CREATE TABLE IF NOT EXISTS households (
    household_id      TEXT NOT NULL,
    coop_id           TEXT NOT NULL REFERENCES cooperatives(coop_id) ON DELETE CASCADE,
    did               TEXT,
    ss58_address      TEXT,
    adapter_vendor    TEXT,
    adapter_model     TEXT,
    capabilities_json TEXT,
    last_seen_at      INTEGER,
    created_at        INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
    PRIMARY KEY (household_id, coop_id)
);
CREATE INDEX IF NOT EXISTS idx_household_did ON households(did);
CREATE INDEX IF NOT EXISTS idx_household_coop ON households(coop_id);

CREATE TABLE IF NOT EXISTS devices (
    device_id         TEXT PRIMARY KEY,
    household_id      TEXT NOT NULL,
    coop_id           TEXT NOT NULL,
    vendor            TEXT NOT NULL,
    model             TEXT,
    role              TEXT NOT NULL,        -- 'pv' | 'battery' | 'grid' | 'composite'
    binding_json      TEXT,                  -- {"pv": "sensor.x", ...}
    is_controllable   INTEGER NOT NULL DEFAULT 0,
    created_at        INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
);
CREATE INDEX IF NOT EXISTS idx_device_household ON devices(household_id, coop_id);

CREATE TABLE IF NOT EXISTS offers (
    offer_id          TEXT PRIMARY KEY,
    coop_id           TEXT NOT NULL,
    household_id      TEXT NOT NULL,
    seller_did        TEXT,
    kwh               REAL NOT NULL,
    price_ct_per_kwh  REAL NOT NULL,
    valid_until       INTEGER NOT NULL,
    block_number      INTEGER,
    extrinsic_hash    TEXT,
    status            TEXT NOT NULL DEFAULT 'open', -- open|matched|expired|cancelled
    received_at       INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
);
CREATE INDEX IF NOT EXISTS idx_offers_coop_status ON offers(coop_id, status);
CREATE INDEX IF NOT EXISTS idx_offers_received ON offers(received_at);

CREATE TABLE IF NOT EXISTS matches (
    match_id          INTEGER PRIMARY KEY AUTOINCREMENT,
    offer_id          TEXT NOT NULL REFERENCES offers(offer_id),
    coop_id           TEXT NOT NULL,
    buyer_did         TEXT NOT NULL,
    clearing_price_ct REAL NOT NULL,
    matched_at        INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
);
CREATE INDEX IF NOT EXISTS idx_matches_coop_time ON matches(coop_id, matched_at);

CREATE TABLE IF NOT EXISTS settlements (
    settlement_id     INTEGER PRIMARY KEY AUTOINCREMENT,
    match_id          INTEGER NOT NULL REFERENCES matches(match_id),
    coop_id           TEXT NOT NULL,
    household_id      TEXT NOT NULL,
    kwh               REAL NOT NULL,
    revenue_ct        REAL NOT NULL,
    settled_at        INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
);
CREATE INDEX IF NOT EXISTS idx_settlements_coop_household_time
    ON settlements(coop_id, household_id, settled_at);

-- Lightweight time-series of household heartbeats (downsampled in API)
CREATE TABLE IF NOT EXISTS heartbeats (
    coop_id           TEXT NOT NULL,
    household_id      TEXT NOT NULL,
    ts                INTEGER NOT NULL,
    surplus_w         REAL,
    pv_w              REAL,
    battery_soc       REAL,
    battery_w         REAL,
    grid_export_w     REAL,
    block             INTEGER,
    trading           INTEGER,
    PRIMARY KEY (coop_id, household_id, ts)
);
CREATE INDEX IF NOT EXISTS idx_heartbeats_time ON heartbeats(ts);
"""

DDL_V2 = """
-- Per-coop config, e.g. clearing strategy, fee schedule
CREATE TABLE IF NOT EXISTS coop_settings (
    coop_id           TEXT PRIMARY KEY REFERENCES cooperatives(coop_id) ON DELETE CASCADE,
    match_interval_s  INTEGER NOT NULL DEFAULT 15,
    fee_pct           REAL    NOT NULL DEFAULT 0.0,
    settings_json     TEXT
);
"""


@asynccontextmanager
async def db() -> AsyncIterator[aiosqlite.Connection]:
    conn = await aiosqlite.connect(DB_PATH)
    conn.row_factory = aiosqlite.Row
    await conn.execute("PRAGMA foreign_keys=ON")
    await conn.execute("PRAGMA journal_mode=WAL")
    try:
        yield conn
    finally:
        await conn.close()


async def init_schema() -> None:
    """Run on Hub startup. Idempotent — safe to call repeatedly."""
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    async with db() as conn:
        await conn.executescript(DDL_V1)
        # Check current schema version
        async with conn.execute("SELECT MAX(version) FROM schema_version") as cur:
            row = await cur.fetchone()
            current = (row[0] if row and row[0] else 0)

        if current < 2:
            await conn.executescript(DDL_V2)

        await conn.execute(
            "INSERT OR REPLACE INTO schema_version (version) VALUES (?)",
            (SCHEMA_VERSION,),
        )
        # Seed default cooperative if none exists
        async with conn.execute("SELECT COUNT(*) FROM cooperatives") as cur:
            count = (await cur.fetchone())[0]
        if count == 0:
            await conn.execute(
                "INSERT INTO cooperatives (coop_id, name) VALUES (?, ?)",
                ("heutestadtmorgen", "heute stadt morgen eG"),
            )
        await conn.commit()
    _LOGGER.info("DB schema ready at %s (version %d)", DB_PATH, SCHEMA_VERSION)
