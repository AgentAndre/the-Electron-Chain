"""Repository layer — async data-access for the ELP-Hub addon.

One class per aggregate. All public methods are coroutines and return
plain dicts so FastAPI can serialize them directly. No ORM — the SQL is
short enough that the indirection costs more than it saves at this scale.
"""
from __future__ import annotations

import json
import time
from typing import Any

from db import db


class CooperativeRepo:

    async def list(self) -> list[dict[str, Any]]:
        async with db() as conn:
            async with conn.execute(
                "SELECT coop_id, name, vnb_id, bilanzkreis_id, created_at FROM cooperatives"
            ) as cur:
                return [dict(r) for r in await cur.fetchall()]

    async def get(self, coop_id: str) -> dict[str, Any] | None:
        async with db() as conn:
            async with conn.execute(
                "SELECT * FROM cooperatives WHERE coop_id=?", (coop_id,)
            ) as cur:
                row = await cur.fetchone()
                return dict(row) if row else None

    async def upsert(self, coop_id: str, name: str, vnb_id: str | None = None) -> None:
        async with db() as conn:
            await conn.execute(
                """INSERT INTO cooperatives (coop_id, name, vnb_id) VALUES (?, ?, ?)
                   ON CONFLICT(coop_id) DO UPDATE SET name=excluded.name,
                                                       vnb_id=excluded.vnb_id""",
                (coop_id, name, vnb_id),
            )
            await conn.commit()


class HouseholdRepo:

    async def list(self, coop_id: str, *, limit: int = 1000, offset: int = 0) -> list[dict[str, Any]]:
        async with db() as conn:
            async with conn.execute(
                """SELECT h.*, COALESCE(SUM(s.kwh), 0) AS traded_kwh_today,
                          COALESCE(SUM(s.revenue_ct), 0) AS revenue_today_ct
                   FROM households h
                   LEFT JOIN settlements s ON s.household_id=h.household_id
                       AND s.coop_id=h.coop_id
                       AND s.settled_at >= ?
                   WHERE h.coop_id=?
                   GROUP BY h.household_id
                   ORDER BY h.household_id
                   LIMIT ? OFFSET ?""",
                (_today_unix(), coop_id, limit, offset),
            ) as cur:
                rows = await cur.fetchall()
                out = []
                for r in rows:
                    d = dict(r)
                    if d.get("capabilities_json"):
                        d["capabilities"] = json.loads(d.pop("capabilities_json"))
                    out.append(d)
                return out

    async def upsert(self, body: dict[str, Any]) -> None:
        async with db() as conn:
            await conn.execute(
                """INSERT INTO households
                   (household_id, coop_id, did, ss58_address, adapter_vendor,
                    adapter_model, capabilities_json, last_seen_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(household_id, coop_id) DO UPDATE SET
                     did=excluded.did,
                     ss58_address=excluded.ss58_address,
                     adapter_vendor=excluded.adapter_vendor,
                     adapter_model=excluded.adapter_model,
                     capabilities_json=excluded.capabilities_json,
                     last_seen_at=excluded.last_seen_at""",
                (
                    body["household_id"],
                    body["cooperative_id"],
                    body.get("did"),
                    body.get("ss58_address"),
                    body.get("adapter_vendor"),
                    body.get("adapter_model"),
                    json.dumps(body.get("capabilities", [])),
                    int(time.time()),
                ),
            )
            await conn.commit()

    async def touch_seen(self, coop_id: str, household_id: str) -> None:
        async with db() as conn:
            await conn.execute(
                "UPDATE households SET last_seen_at=? WHERE coop_id=? AND household_id=?",
                (int(time.time()), coop_id, household_id),
            )
            await conn.commit()


class OfferRepo:

    async def insert(self, payload: dict[str, Any]) -> None:
        async with db() as conn:
            await conn.execute(
                """INSERT OR REPLACE INTO offers
                   (offer_id, coop_id, household_id, seller_did, kwh,
                    price_ct_per_kwh, valid_until, block_number, extrinsic_hash, status)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')""",
                (
                    payload["offer_id"],
                    payload.get("cooperative_id") or payload.get("coop_id"),
                    payload["household_id"],
                    payload.get("seller_did"),
                    payload["kwh"],
                    payload["price_ct_per_kwh"],
                    payload["valid_until"],
                    payload.get("block"),
                    payload.get("tx"),
                ),
            )
            await conn.commit()

    async def open_book(self, coop_id: str, *, limit: int = 200) -> list[dict[str, Any]]:
        async with db() as conn:
            async with conn.execute(
                """SELECT * FROM offers
                   WHERE coop_id=? AND status='open' AND valid_until > ?
                   ORDER BY price_ct_per_kwh ASC, received_at ASC
                   LIMIT ?""",
                (coop_id, int(time.time()), limit),
            ) as cur:
                return [dict(r) for r in await cur.fetchall()]

    async def mark_matched(self, offer_id: str) -> None:
        async with db() as conn:
            await conn.execute(
                "UPDATE offers SET status='matched' WHERE offer_id=?", (offer_id,)
            )
            await conn.commit()

    async def expire_old(self, coop_id: str) -> int:
        async with db() as conn:
            cur = await conn.execute(
                """UPDATE offers SET status='expired'
                   WHERE coop_id=? AND status='open' AND valid_until <= ?""",
                (coop_id, int(time.time())),
            )
            await conn.commit()
            return cur.rowcount


class MatchRepo:

    async def insert(
        self,
        offer_id: str,
        coop_id: str,
        buyer_did: str,
        clearing_price_ct: float,
    ) -> int:
        async with db() as conn:
            cur = await conn.execute(
                """INSERT INTO matches (offer_id, coop_id, buyer_did, clearing_price_ct)
                   VALUES (?, ?, ?, ?)""",
                (offer_id, coop_id, buyer_did, clearing_price_ct),
            )
            await conn.commit()
            return cur.lastrowid

    async def recent(self, coop_id: str, *, limit: int = 100) -> list[dict[str, Any]]:
        async with db() as conn:
            async with conn.execute(
                """SELECT m.*, o.household_id, o.kwh
                   FROM matches m JOIN offers o ON o.offer_id=m.offer_id
                   WHERE m.coop_id=?
                   ORDER BY m.matched_at DESC
                   LIMIT ?""",
                (coop_id, limit),
            ) as cur:
                return [dict(r) for r in await cur.fetchall()]


class SettlementRepo:

    async def insert(
        self,
        match_id: int,
        coop_id: str,
        household_id: str,
        kwh: float,
        revenue_ct: float,
    ) -> None:
        async with db() as conn:
            await conn.execute(
                """INSERT INTO settlements
                   (match_id, coop_id, household_id, kwh, revenue_ct)
                   VALUES (?, ?, ?, ?, ?)""",
                (match_id, coop_id, household_id, kwh, revenue_ct),
            )
            await conn.commit()

    async def daily_totals(self, coop_id: str) -> dict[str, float]:
        async with db() as conn:
            async with conn.execute(
                """SELECT COALESCE(SUM(kwh),0) AS kwh,
                          COALESCE(SUM(revenue_ct),0) AS revenue_ct,
                          COUNT(*) AS n_settlements
                   FROM settlements WHERE coop_id=? AND settled_at >= ?""",
                (coop_id, _today_unix()),
            ) as cur:
                row = await cur.fetchone()
                return {
                    "kwh": row["kwh"],
                    "revenue_ct": row["revenue_ct"],
                    "n_settlements": row["n_settlements"],
                }


class HeartbeatRepo:

    async def insert(self, payload: dict[str, Any]) -> None:
        async with db() as conn:
            await conn.execute(
                """INSERT OR REPLACE INTO heartbeats
                   (coop_id, household_id, ts, surplus_w, pv_w, battery_soc,
                    battery_w, grid_export_w, block, trading)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    payload.get("coop_id", "heutestadtmorgen"),
                    payload["household_id"],
                    payload["ts"],
                    payload.get("surplus_w"),
                    payload.get("pv_w"),
                    payload.get("battery_soc"),
                    payload.get("battery_w"),
                    payload.get("grid_export_w"),
                    payload.get("block"),
                    1 if payload.get("trading") else 0,
                ),
            )
            await conn.commit()

    async def aggregate_minute(self, coop_id: str, minutes: int = 60) -> list[dict[str, Any]]:
        since = int(time.time()) - minutes * 60
        async with db() as conn:
            async with conn.execute(
                """SELECT (ts/60)*60 AS bucket,
                          SUM(surplus_w) AS total_surplus_w,
                          SUM(pv_w) AS total_pv_w,
                          AVG(battery_soc) AS avg_soc,
                          COUNT(DISTINCT household_id) AS n_households
                   FROM heartbeats
                   WHERE coop_id=? AND ts >= ?
                   GROUP BY bucket
                   ORDER BY bucket ASC""",
                (coop_id, since),
            ) as cur:
                return [dict(r) for r in await cur.fetchall()]

    async def prune(self, older_than_seconds: int = 86400) -> int:
        async with db() as conn:
            cur = await conn.execute(
                "DELETE FROM heartbeats WHERE ts < ?",
                (int(time.time()) - older_than_seconds,),
            )
            await conn.commit()
            return cur.rowcount


class SecretsVaultRepo:
    """Persists Fernet-wrapped secrets (e.g. the addon-side wallet seed).

    The plaintext is never written to disk — only the ciphertext, salt,
    KDF parameters, and a verifier blob that lets us confirm the user's
    passphrase before attempting to decrypt the real payload.
    """

    async def upsert(
        self,
        name: str,
        *,
        kdf: str,
        salt_b64: str,
        iterations: int,
        ciphertext_b64: str,
        verifier_b64: str,
    ) -> None:
        async with db() as conn:
            await conn.execute(
                """INSERT INTO secrets_vault
                   (name, kdf, salt_b64, iterations, ciphertext_b64, verifier_b64, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(name) DO UPDATE SET
                     kdf=excluded.kdf,
                     salt_b64=excluded.salt_b64,
                     iterations=excluded.iterations,
                     ciphertext_b64=excluded.ciphertext_b64,
                     verifier_b64=excluded.verifier_b64,
                     updated_at=excluded.updated_at""",
                (name, kdf, salt_b64, iterations, ciphertext_b64, verifier_b64, int(time.time())),
            )
            await conn.commit()

    async def get(self, name: str) -> dict[str, Any] | None:
        async with db() as conn:
            async with conn.execute(
                "SELECT * FROM secrets_vault WHERE name=?", (name,)
            ) as cur:
                row = await cur.fetchone()
                return dict(row) if row else None

    async def delete(self, name: str) -> bool:
        async with db() as conn:
            cur = await conn.execute("DELETE FROM secrets_vault WHERE name=?", (name,))
            await conn.commit()
            return cur.rowcount > 0

    async def names(self) -> list[str]:
        async with db() as conn:
            async with conn.execute(
                "SELECT name, updated_at FROM secrets_vault ORDER BY name"
            ) as cur:
                return [dict(r) for r in await cur.fetchall()]


def _today_unix() -> int:
    """Unix timestamp of today 00:00 local-ish (UTC for simplicity)."""
    now = int(time.time())
    return now - (now % 86400)
