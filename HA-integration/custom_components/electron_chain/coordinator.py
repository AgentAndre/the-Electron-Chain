"""DataUpdateCoordinator — adapter-driven version."""
from __future__ import annotations

import asyncio
import json
import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

import aiohttp

from homeassistant.components import mqtt
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator

from .adapters import DeviceAdapter, DeviceReading, get_adapter
from .const import (
    CONF_ADAPTER_BINDING,
    CONF_ADAPTER_VENDOR,
    CONF_HUB_API_URL,
    DEFAULT_HUB_API_URL,
    DEFAULT_MIN_SURPLUS_W,
    DEFAULT_OFFER_INTERVAL_SEC,
    DEFAULT_UPDATE_INTERVAL_SEC,
    STATE_ADAPTER,
    STATE_BATTERY_SOC,
    STATE_CHAIN_BLOCK,
    STATE_DID,
    STATE_LAST_MATCH,
    STATE_OFFER_ID,
    STATE_OFFER_PRICE,
    STATE_PV_W,
    STATE_REVENUE_TODAY,
    STATE_STATUS,
    STATE_SURPLUS_W,
    STATE_TRADED_KWH_TODAY,
    STATUS_CONSUMING,
    STATUS_DISCONNECTED,
    STATUS_IDLE,
    STATUS_MATCHED,
    STATUS_NO_DEVICE,
    STATUS_OFFERING,
    TOPIC_GRID_PRICE,
    TOPIC_HOUSEHOLD_HEARTBEAT,
    TOPIC_MATCH,
    TOPIC_OFFER_BOOK,
    TOPIC_OFFER_PUBLISH,
    TOPIC_SETTLEMENT,
)
from .peaq_client import FlexibilityOffer, PeaqClient, PeaqExtrinsicError

_LOGGER = logging.getLogger(__name__)


class ElectronChainCoordinator(DataUpdateCoordinator):
    """Polls adapter, posts offers, listens to Hub."""

    def __init__(
        self,
        hass: HomeAssistant,
        entry: ConfigEntry,
        client: PeaqClient,
    ) -> None:
        super().__init__(
            hass,
            _LOGGER,
            name="electron_chain",
            update_interval=timedelta(seconds=DEFAULT_UPDATE_INTERVAL_SEC),
        )
        self._entry = entry
        self._client = client
        self._unsub_mqtt: list = []
        self._last_offer_at: datetime | None = None
        self._traded_kwh_today: float = 0.0
        self._revenue_today_ct: float = 0.0
        self._current_grid_price_ct: float = 30.0
        self._trading_enabled: bool = True

        self._coop = entry.data["cooperative_id"]
        self._household = entry.data["household_id"]
        self._hub_api = entry.data.get(CONF_HUB_API_URL, DEFAULT_HUB_API_URL)

        # Build the adapter
        adapter_cls = get_adapter(entry.data.get(CONF_ADAPTER_VENDOR, "generic"))
        if adapter_cls is None:
            raise RuntimeError(
                f"Unknown adapter vendor: {entry.data.get(CONF_ADAPTER_VENDOR)}"
            )
        self._adapter: DeviceAdapter = adapter_cls(
            entity_overrides=entry.data.get(CONF_ADAPTER_BINDING, {}),
        )
        _LOGGER.info(
            "Coordinator using adapter %s (%s)",
            self._adapter.vendor,
            self._adapter.model,
        )

    # ---------- main loop ----------

    async def _async_update_data(self) -> dict[str, Any]:
        try:
            block = await self._client.async_get_block_number()
        except Exception as err:  # noqa: BLE001
            _LOGGER.warning("Chain liveness failed: %s", err)
            return self._build_state(STATUS_DISCONNECTED)

        # Read device state via the adapter (sync, in executor)
        reading: DeviceReading = await self.hass.async_add_executor_job(
            self._adapter.read_state, self.hass
        )

        if not reading.is_complete_enough_to_trade():
            return self._build_state(STATUS_NO_DEVICE, reading=reading, chain_block=block)

        surplus_w = reading.surplus_w()

        # Heartbeat to Hub (so the dashboard knows we're alive)
        await self._publish_heartbeat(reading, surplus_w, block)

        # Decide whether to publish a fresh offer
        if (
            self._trading_enabled
            and surplus_w > DEFAULT_MIN_SURPLUS_W
            and self._should_post_offer()
        ):
            offer = await self._post_offer(surplus_w)
            if offer:
                return self._build_state(
                    STATUS_OFFERING,
                    reading=reading,
                    offer_id=offer.offer_id,
                    offer_price=offer.price_ct_per_kwh,
                    chain_block=offer.block_number or block,
                )

        if surplus_w > DEFAULT_MIN_SURPLUS_W:
            status = STATUS_OFFERING if self._trading_enabled else STATUS_IDLE
        elif surplus_w < -DEFAULT_MIN_SURPLUS_W:
            status = STATUS_CONSUMING
        else:
            status = STATUS_IDLE

        return self._build_state(status, reading=reading, chain_block=block)

    # ---------- MQTT side-channel ----------

    async def async_start_hub_listener(self) -> None:
        topics = [
            (TOPIC_MATCH.format(coop=self._coop, household=self._household), self._on_match),
            (TOPIC_SETTLEMENT.format(coop=self._coop, household=self._household), self._on_settlement),
            (TOPIC_GRID_PRICE.format(coop=self._coop), self._on_grid_price),
            (TOPIC_OFFER_BOOK.format(coop=self._coop), self._on_book_update),
        ]
        for topic, handler in topics:
            self._unsub_mqtt.append(
                await mqtt.async_subscribe(self.hass, topic, handler)
            )
        _LOGGER.debug("Subscribed to %d Hub topics", len(self._unsub_mqtt))

    @callback
    def _on_match(self, msg) -> None:
        try:
            payload = json.loads(msg.payload)
            self.async_set_updated_data(
                {**(self.data or {}), STATE_LAST_MATCH: payload, STATE_STATUS: STATUS_MATCHED}
            )
        except json.JSONDecodeError:
            _LOGGER.warning("Bad match payload")

    @callback
    def _on_settlement(self, msg) -> None:
        try:
            payload = json.loads(msg.payload)
            self._traded_kwh_today += float(payload.get("kwh", 0))
            self._revenue_today_ct += float(payload.get("revenue_ct", 0))
        except (json.JSONDecodeError, ValueError):
            _LOGGER.warning("Bad settlement payload")

    @callback
    def _on_grid_price(self, msg) -> None:
        try:
            self._current_grid_price_ct = float(msg.payload)
        except ValueError:
            pass

    @callback
    def _on_book_update(self, msg) -> None:
        # The dashboard consumes this directly via WebSocket.
        pass

    # ---------- Hub registration (one-shot at setup) ----------

    async def async_register_with_hub(self) -> None:
        """POST /v1/households so the Hub knows about us."""
        url = f"{self._hub_api}/v1/households"
        body = {
            "household_id": self._household,
            "cooperative_id": self._coop,
            "did": self._client.wallet_did,
            "ss58_address": self._client.ss58_address,
            "adapter_vendor": self._adapter.vendor,
            "adapter_model": self._adapter.model,
            "capabilities": sorted(self._adapter.capabilities),
        }
        try:
            session = async_get_clientsession(self.hass)
            async with session.post(url, json=body, timeout=aiohttp.ClientTimeout(total=5)) as resp:
                if resp.status >= 400:
                    _LOGGER.warning("Hub registration HTTP %s: %s", resp.status, await resp.text())
                else:
                    _LOGGER.info("Registered with Hub at %s", url)
        except (aiohttp.ClientError, asyncio.TimeoutError) as err:
            _LOGGER.warning("Hub unreachable at %s — will keep working offline (%s)", url, err)

    async def _publish_heartbeat(
        self, reading: DeviceReading, surplus_w: float, block: int
    ) -> None:
        topic = TOPIC_HOUSEHOLD_HEARTBEAT.format(coop=self._coop, household=self._household)
        payload = {
            "household_id": self._household,
            "ts": int(datetime.now(timezone.utc).timestamp()),
            "surplus_w": round(surplus_w, 1),
            "pv_w": reading.pv_power_w,
            "battery_soc": reading.battery_soc_pct,
            "battery_w": reading.battery_power_w,
            "grid_export_w": reading.grid_export_w,
            "vendor": self._adapter.vendor,
            "block": block,
            "trading": self._trading_enabled,
        }
        try:
            await mqtt.async_publish(self.hass, topic, json.dumps(payload), qos=0, retain=True)
        except Exception as err:  # noqa: BLE001
            _LOGGER.debug("Heartbeat publish failed: %s", err)

    # ---------- helpers ----------

    def _should_post_offer(self) -> bool:
        if self._last_offer_at is None:
            return True
        age = datetime.now(timezone.utc) - self._last_offer_at
        return age.total_seconds() >= DEFAULT_OFFER_INTERVAL_SEC

    async def _post_offer(self, surplus_w: float) -> FlexibilityOffer | None:
        kwh = (surplus_w * DEFAULT_OFFER_INTERVAL_SEC) / 3_600_000.0
        price = max(self._current_grid_price_ct - 5, 5.0)

        offer = FlexibilityOffer(
            offer_id=uuid.uuid4().hex[:16],
            seller_did=self._client.wallet_did,
            kwh=round(kwh, 4),
            price_ct_per_kwh=round(price, 2),
            valid_until=int(
                (datetime.now(timezone.utc) + timedelta(minutes=15)).timestamp()
            ),
            cooperative_id=self._coop,
        )

        try:
            offer = await self._client.async_submit_offer(offer)
        except PeaqExtrinsicError as err:
            _LOGGER.error("Offer submission failed: %s", err)
            return None

        topic = TOPIC_OFFER_PUBLISH.format(coop=self._coop)
        await mqtt.async_publish(
            self.hass,
            topic,
            json.dumps(
                {
                    "offer_id": offer.offer_id,
                    "seller_did": offer.seller_did,
                    "household_id": self._household,
                    "kwh": offer.kwh,
                    "price_ct_per_kwh": offer.price_ct_per_kwh,
                    "valid_until": offer.valid_until,
                    "block": offer.block_number,
                    "tx": offer.extrinsic_hash,
                }
            ),
            qos=1,
        )
        self._last_offer_at = datetime.now(timezone.utc)
        return offer

    def _build_state(
        self,
        status: str,
        *,
        reading: DeviceReading | None = None,
        offer_id: str | None = None,
        offer_price: float | None = None,
        chain_block: int | None = None,
    ) -> dict[str, Any]:
        prev = self.data or {}
        return {
            STATE_STATUS: status,
            STATE_SURPLUS_W: round(reading.surplus_w(), 1) if reading else 0.0,
            STATE_PV_W: reading.pv_power_w if reading else None,
            STATE_BATTERY_SOC: reading.battery_soc_pct if reading else None,
            STATE_OFFER_ID: offer_id or prev.get(STATE_OFFER_ID),
            STATE_OFFER_PRICE: offer_price or prev.get(STATE_OFFER_PRICE),
            STATE_LAST_MATCH: prev.get(STATE_LAST_MATCH),
            STATE_TRADED_KWH_TODAY: round(self._traded_kwh_today, 3),
            STATE_REVENUE_TODAY: round(self._revenue_today_ct, 2),
            STATE_DID: self._client.wallet_did,
            STATE_CHAIN_BLOCK: chain_block,
            STATE_ADAPTER: self._adapter.vendor,
        }

    def set_trading(self, enabled: bool) -> None:
        self._trading_enabled = enabled

    @property
    def trading_enabled(self) -> bool:
        return self._trading_enabled

    async def async_shutdown(self) -> None:
        for unsub in self._unsub_mqtt:
            unsub()
        await self._client.async_close()
