"""ELP-Hub — addon entry point.

The Hub runs five concurrent tasks in one process:
  1. MQTT consumer — receives offers + heartbeats, writes to SQLite
  2. Matching loop — clears the book every MATCH_INTERVAL_SEC (uniform-price)
  3. Price oracle — publishes a grid-price reference value
  4. DB pruning — drops raw heartbeats older than HEARTBEAT_PRUNE_SEC
  5. FastAPI/uvicorn — serves the dashboard, REST, and WebSocket

Config sources, in precedence order:
  1. Explicit env vars (LOG_LEVEL, MQTT_HOST, …) — set by run.sh or operator
  2. /data/options.json — written by HA Supervisor from config.yaml
  3. Built-in defaults
"""
from __future__ import annotations

import asyncio
import json
import logging
import math
import os
import signal
import time

import aiomqtt
import uvicorn

from api import app, mark_live
from db import init_schema
from repositories import (
    HeartbeatRepo,
    HouseholdRepo,
    MatchRepo,
    OfferRepo,
    SettlementRepo,
)

OPTIONS_PATH = os.environ.get("OPTIONS_PATH", "/data/options.json")


def _load_options() -> dict:
    """Read HA addon options if present; fall back to empty dict otherwise."""
    try:
        with open(OPTIONS_PATH, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except FileNotFoundError:
        return {}
    except (OSError, json.JSONDecodeError) as err:
        logging.getLogger("elp-hub").warning(
            "Could not parse %s (%s) — using defaults", OPTIONS_PATH, err
        )
        return {}


_OPTS = _load_options()


def _opt(key: str, default):
    """Env var > options.json > default."""
    env = os.environ.get(key.upper())
    if env is not None and env != "":
        return env
    if key in _OPTS and _OPTS[key] not in (None, ""):
        return _OPTS[key]
    return default


LOG_LEVEL = str(_opt("log_level", "info")).upper()
MQTT_HOST = str(_opt("mqtt_host", "core-mosquitto"))
MQTT_PORT = int(_opt("mqtt_port", 1883))
MQTT_USERNAME = str(_opt("mqtt_username", "") or "")
MQTT_PASSWORD = str(_opt("mqtt_password", "") or "")
COOP_ID = str(_opt("coop_id", "heutestadtmorgen"))
MATCH_INTERVAL_SEC = int(_opt("match_interval_sec", 15))
GRID_PRICE_DEFAULT_CT = float(_opt("grid_price_default_ct", 32.0))
HUB_API_PORT = int(_opt("hub_api_port", 8099))
HEARTBEAT_PRUNE_SEC = int(_opt("heartbeat_prune_sec", 86400))

logging.basicConfig(
    level=LOG_LEVEL,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
log = logging.getLogger("elp-hub")


class Hub:
    def __init__(self) -> None:
        self.shutdown = asyncio.Event()
        self.offer_repo = OfferRepo()
        self.match_repo = MatchRepo()
        self.settle_repo = SettlementRepo()
        self.hb_repo = HeartbeatRepo()
        self.hh_repo = HouseholdRepo()

    async def run(self) -> None:
        await init_schema()
        log.info(
            "ELP-Hub starting coop=%s broker=%s:%s api=:%d match_interval=%ds",
            COOP_ID, MQTT_HOST, MQTT_PORT, HUB_API_PORT, MATCH_INTERVAL_SEC,
        )

        await asyncio.gather(
            self._mqtt_loop(),
            self._match_loop(),
            self._price_oracle_loop(),
            self._prune_loop(),
            self._api_loop(),
            self._wait_shutdown(),
        )

    # ---------------- MQTT consumer ----------------

    async def _mqtt_loop(self) -> None:
        topics = [
            (f"elp/{COOP_ID}/offers/publish", self._on_offer),
            (f"elp/{COOP_ID}/heartbeat/+", self._on_heartbeat),
        ]
        client_kwargs: dict = {"hostname": MQTT_HOST, "port": MQTT_PORT}
        if MQTT_USERNAME:
            client_kwargs["username"] = MQTT_USERNAME
            client_kwargs["password"] = MQTT_PASSWORD

        while not self.shutdown.is_set():
            try:
                async with aiomqtt.Client(**client_kwargs) as client:
                    for topic, _ in topics:
                        await client.subscribe(topic)
                    log.info("MQTT subscribed: %s", [t for t, _ in topics])
                    self._mqtt_client = client
                    async for msg in client.messages:
                        for topic, handler in topics:
                            if msg.topic.matches(topic):
                                await handler(msg)
                                break
            except (aiomqtt.MqttError, OSError) as err:
                log.warning("MQTT broken (%s) — retry in 3s", err)
                try:
                    await asyncio.wait_for(self.shutdown.wait(), timeout=3)
                    return
                except asyncio.TimeoutError:
                    continue

    async def _on_offer(self, msg) -> None:
        try:
            payload = json.loads(msg.payload)
            payload["coop_id"] = COOP_ID
            await self.offer_repo.insert(payload)
            log.info(
                "OFFER %s %s %.3f kWh @ %.2f ct",
                payload["offer_id"][:8],
                payload["household_id"],
                payload["kwh"],
                payload["price_ct_per_kwh"],
            )
        except (json.JSONDecodeError, KeyError, TypeError) as err:
            log.warning("Bad offer payload: %s (%s)", msg.payload[:120], err)

    async def _on_heartbeat(self, msg) -> None:
        try:
            payload = json.loads(msg.payload)
            payload["coop_id"] = COOP_ID
            mark_live(COOP_ID, payload["household_id"], payload)
            await self.hb_repo.insert(payload)
            await self.hh_repo.touch_seen(COOP_ID, payload["household_id"])
        except (json.JSONDecodeError, KeyError, TypeError) as err:
            log.debug("Bad heartbeat: %s", err)

    # ---------------- matching engine ----------------

    async def _match_loop(self) -> None:
        while not self.shutdown.is_set():
            try:
                await asyncio.wait_for(
                    self.shutdown.wait(), timeout=MATCH_INTERVAL_SEC
                )
                break
            except asyncio.TimeoutError:
                pass

            n_expired = await self.offer_repo.expire_old(COOP_ID)
            book = await self.offer_repo.open_book(COOP_ID, limit=10000)
            if len(book) < 2:
                continue

            half = max(1, len(book) // 2)
            cleared = book[:half]
            clearing_price = book[len(book) // 2]["price_ct_per_kwh"]
            log.info(
                "MATCH %d/%d cleared @ uniform %.2f ct/kWh (expired=%d)",
                len(cleared), len(book), clearing_price, n_expired,
            )

            for offer in cleared:
                match_id = await self.match_repo.insert(
                    offer["offer_id"],
                    COOP_ID,
                    "cooperative_pool",
                    clearing_price,
                )
                await self.offer_repo.mark_matched(offer["offer_id"])
                revenue = float(offer["kwh"]) * clearing_price
                await self.settle_repo.insert(
                    match_id, COOP_ID, offer["household_id"],
                    float(offer["kwh"]), revenue,
                )
                await self._publish_match(offer, clearing_price, match_id)

    async def _publish_match(self, offer, clearing_price, match_id) -> None:
        if not hasattr(self, "_mqtt_client"):
            return
        try:
            match_topic = f"elp/{COOP_ID}/match/{offer['household_id']}"
            settle_topic = f"elp/{COOP_ID}/settlement/{offer['household_id']}"
            revenue = float(offer["kwh"]) * clearing_price
            await self._mqtt_client.publish(
                match_topic,
                json.dumps({
                    "match_id": match_id,
                    "offer_id": offer["offer_id"],
                    "clearing_price_ct_kwh": clearing_price,
                    "kwh": offer["kwh"],
                    "matched_at": int(time.time()),
                }),
                qos=1,
            )
            await self._mqtt_client.publish(
                settle_topic,
                json.dumps({
                    "match_id": match_id,
                    "offer_id": offer["offer_id"],
                    "kwh": offer["kwh"],
                    "price_ct_kwh": clearing_price,
                    "revenue_ct": round(revenue, 2),
                    "settled_at": int(time.time()),
                }),
                qos=1,
            )
        except Exception as err:  # noqa: BLE001
            log.warning("Match publish failed: %s", err)

    # ---------------- grid-price oracle (sinusoidal stand-in) ----------------

    async def _price_oracle_loop(self) -> None:
        while not self.shutdown.is_set():
            try:
                if hasattr(self, "_mqtt_client"):
                    t = time.time()
                    price = GRID_PRICE_DEFAULT_CT + 8.0 * math.sin(t / 600.0)
                    await self._mqtt_client.publish(
                        f"elp/{COOP_ID}/grid/price", f"{price:.2f}", retain=True
                    )
                try:
                    await asyncio.wait_for(self.shutdown.wait(), timeout=30)
                    return
                except asyncio.TimeoutError:
                    continue
            except Exception as err:  # noqa: BLE001
                log.debug("Price oracle: %s", err)
                await asyncio.sleep(30)

    # ---------------- DB pruning ----------------

    async def _prune_loop(self) -> None:
        while not self.shutdown.is_set():
            try:
                await asyncio.wait_for(self.shutdown.wait(), timeout=3600)
                return
            except asyncio.TimeoutError:
                pass
            n = await self.hb_repo.prune(HEARTBEAT_PRUNE_SEC)
            if n:
                log.info("Pruned %d old heartbeat rows", n)

    # ---------------- HTTP / WS server ----------------

    async def _api_loop(self) -> None:
        config = uvicorn.Config(
            app,
            host="0.0.0.0",
            port=HUB_API_PORT,
            log_level=LOG_LEVEL.lower(),
            access_log=False,
        )
        server = uvicorn.Server(config)
        await server.serve()

    async def _wait_shutdown(self) -> None:
        await self.shutdown.wait()


def _install_signal_handlers(hub: Hub) -> None:
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, hub.shutdown.set)


async def main() -> None:
    hub = Hub()
    _install_signal_handlers(hub)
    await hub.run()


if __name__ == "__main__":
    asyncio.run(main())
