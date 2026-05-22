"""FastAPI HTTP + WebSocket server for the addon dashboard.

Endpoints:
  GET    /api/health                                          (HA addon healthcheck)
  GET    /v1/cooperatives
  GET    /v1/cooperatives/{coop_id}/households                (paginated)
  GET    /v1/cooperatives/{coop_id}/orderbook
  GET    /v1/cooperatives/{coop_id}/matches/recent
  GET    /v1/cooperatives/{coop_id}/aggregate/last-hour
  GET    /v1/cooperatives/{coop_id}/kpis
  POST   /v1/households                                       (HA integration → Hub)

  GET    /v1/vault                                            (list secret names)
  POST   /v1/vault/{name}                                     (encrypt & store)
  POST   /v1/vault/{name}/unlock                              (verify passphrase, return plaintext)
  DELETE /v1/vault/{name}                                     (remove)

  WS     /v1/cooperatives/{coop_id}/live                      (delta-stream for dashboard)

The WS pushes server-aggregated state every second so the wire only carries
deltas after the first frame — keeps hundreds-of-households dashboards
tractable in a browser.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from db import init_schema
from repositories import (
    CooperativeRepo,
    HeartbeatRepo,
    HouseholdRepo,
    MatchRepo,
    OfferRepo,
    SecretsVaultRepo,
    SettlementRepo,
)
from wallet_crypto import (
    EncryptedSecret,
    VaultError,
    WrongPassphrase,
    decrypt_secret,
    encrypt_secret,
)

_LOGGER = logging.getLogger(__name__)

_LIVE: dict[tuple[str, str], dict[str, Any]] = {}
_DIRTY: set[tuple[str, str]] = set()


def mark_live(coop: str, household: str, payload: dict[str, Any]) -> None:
    _LIVE[(coop, household)] = payload
    _DIRTY.add((coop, household))


def take_dirty(coop: str) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for key in list(_DIRTY):
        if key[0] != coop:
            continue
        out[key[1]] = _LIVE[key]
        _DIRTY.discard(key)
    return out


# -------------------------------------------------------------- API models

class HouseholdRegister(BaseModel):
    household_id: str
    cooperative_id: str
    did: str | None = None
    ss58_address: str | None = None
    adapter_vendor: str | None = None
    adapter_model: str | None = None
    capabilities: list[str] = []


class VaultStoreRequest(BaseModel):
    plaintext: str = Field(min_length=1)
    passphrase: str = Field(min_length=6)


class VaultUnlockRequest(BaseModel):
    passphrase: str = Field(min_length=6)


# -------------------------------------------------------------- lifespan

@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_schema()
    yield


app = FastAPI(title="The Electron Chain — ELP Hub", version="5.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# -------------------------------------------------------------- health

@app.get("/api/health")
async def health() -> dict[str, Any]:
    return {"ok": True, "service": "elp-hub", "version": "5.0.0", "ts": int(time.time())}


# -------------------------------------------------------------- HTTP routes

@app.get("/v1/cooperatives")
async def list_coops():
    return await CooperativeRepo().list()


@app.get("/v1/cooperatives/{coop_id}/households")
async def list_households(coop_id: str, limit: int = 200, offset: int = 0):
    rows = await HouseholdRepo().list(coop_id, limit=limit, offset=offset)
    for r in rows:
        live = _LIVE.get((coop_id, r["household_id"]))
        if live:
            r["live"] = live
    return rows


@app.post("/v1/households")
async def register_household(body: HouseholdRegister):
    coop = body.cooperative_id
    if not await CooperativeRepo().get(coop):
        await CooperativeRepo().upsert(coop, name=coop.replace("-", " ").title())
    await HouseholdRepo().upsert(body.model_dump())
    return {"ok": True}


@app.get("/v1/cooperatives/{coop_id}/orderbook")
async def orderbook(coop_id: str, limit: int = 50):
    return await OfferRepo().open_book(coop_id, limit=limit)


@app.get("/v1/cooperatives/{coop_id}/matches/recent")
async def recent_matches(coop_id: str, limit: int = 50):
    return await MatchRepo().recent(coop_id, limit=limit)


@app.get("/v1/cooperatives/{coop_id}/aggregate/last-hour")
async def last_hour(coop_id: str):
    return {
        "buckets": await HeartbeatRepo().aggregate_minute(coop_id, minutes=60),
        "totals_today": await SettlementRepo().daily_totals(coop_id),
    }


@app.get("/v1/cooperatives/{coop_id}/kpis")
async def kpis(coop_id: str):
    households = await HouseholdRepo().list(coop_id, limit=10000)
    book = await OfferRepo().open_book(coop_id, limit=1000)
    totals = await SettlementRepo().daily_totals(coop_id)

    active_now = sum(
        1 for h in households
        if (live := _LIVE.get((coop_id, h["household_id"]))) and (
            time.time() - live.get("ts", 0) < 90
        )
    )
    sum_surplus_w = sum(
        (_LIVE.get((coop_id, h["household_id"])) or {}).get("surplus_w") or 0
        for h in households
    )
    sum_pv_w = sum(
        (_LIVE.get((coop_id, h["household_id"])) or {}).get("pv_w") or 0
        for h in households
    )
    return {
        "n_households_total": len(households),
        "n_households_active": active_now,
        "sum_surplus_w": round(sum_surplus_w, 1),
        "sum_pv_w": round(sum_pv_w, 1),
        "n_open_offers": len(book),
        "open_kwh": round(sum(o["kwh"] for o in book), 3),
        "totals_today": totals,
        "ts": int(time.time()),
    }


# -------------------------------------------------------------- vault

@app.get("/v1/vault")
async def vault_list():
    return await SecretsVaultRepo().names()


@app.post("/v1/vault/{name}")
async def vault_store(name: str, body: VaultStoreRequest):
    try:
        enc = encrypt_secret(body.plaintext, body.passphrase)
    except VaultError as err:
        raise HTTPException(status_code=400, detail=str(err)) from err
    await SecretsVaultRepo().upsert(
        name,
        kdf=enc.kdf,
        salt_b64=enc.salt_b64,
        iterations=enc.iterations,
        ciphertext_b64=enc.ciphertext_b64,
        verifier_b64=enc.verifier_b64,
    )
    _LOGGER.info("Vault: stored secret %r (Fernet, kdf=%s)", name, enc.kdf)
    return {"ok": True, "name": name}


@app.post("/v1/vault/{name}/unlock")
async def vault_unlock(name: str, body: VaultUnlockRequest):
    row = await SecretsVaultRepo().get(name)
    if not row:
        raise HTTPException(status_code=404, detail="not found")
    enc = EncryptedSecret(
        kdf=row["kdf"],
        salt_b64=row["salt_b64"],
        iterations=row["iterations"],
        ciphertext_b64=row["ciphertext_b64"],
        verifier_b64=row["verifier_b64"],
    )
    try:
        plaintext = decrypt_secret(enc, body.passphrase)
    except WrongPassphrase as err:
        raise HTTPException(status_code=401, detail="wrong passphrase") from err
    except VaultError as err:
        raise HTTPException(status_code=400, detail=str(err)) from err
    return {"name": name, "plaintext": plaintext}


@app.delete("/v1/vault/{name}")
async def vault_delete(name: str):
    deleted = await SecretsVaultRepo().delete(name)
    if not deleted:
        raise HTTPException(status_code=404, detail="not found")
    return {"ok": True, "name": name}


# -------------------------------------------------------------- WebSocket

@app.websocket("/v1/cooperatives/{coop_id}/live")
async def ws_live(websocket: WebSocket, coop_id: str):
    await websocket.accept()
    last_match_id = 0
    try:
        init_payload = {
            "type": "init",
            "ts": int(time.time()),
            "kpis": await kpis(coop_id),
            "households": await HouseholdRepo().list(coop_id, limit=10000),
            "book": await OfferRepo().open_book(coop_id, limit=50),
            "recent_matches": await MatchRepo().recent(coop_id, limit=20),
        }
        for h in init_payload["households"]:
            live = _LIVE.get((coop_id, h["household_id"]))
            if live:
                h["live"] = live
        await websocket.send_text(json.dumps(init_payload, default=str))

        while True:
            await asyncio.sleep(1.0)
            delta = take_dirty(coop_id)
            new_matches = await MatchRepo().recent(coop_id, limit=20)
            new_matches = [m for m in new_matches if m["match_id"] > last_match_id]
            if new_matches:
                last_match_id = max(m["match_id"] for m in new_matches)

            frame = {
                "type": "delta",
                "ts": int(time.time()),
                "households_delta": delta,
                "new_matches": new_matches,
                "kpis": await kpis(coop_id),
            }
            await websocket.send_text(json.dumps(frame, default=str))

    except WebSocketDisconnect:
        _LOGGER.info("WS client disconnected coop=%s", coop_id)
    except Exception as err:  # noqa: BLE001
        _LOGGER.exception("WS error: %s", err)
        try:
            await websocket.close()
        except Exception:  # noqa: BLE001
            pass


# -------------------------------------------------------------- static dashboard

DASHBOARD_DIR = os.environ.get("DASHBOARD_DIR", "/app/dashboard")
if os.path.isdir(DASHBOARD_DIR):
    app.mount("/static", StaticFiles(directory=DASHBOARD_DIR), name="static")

    @app.get("/")
    async def root():
        return FileResponse(os.path.join(DASHBOARD_DIR, "index.html"))
