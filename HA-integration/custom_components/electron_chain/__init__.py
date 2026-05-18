"""The Electron Chain integration.

Bridges Home Assistant to the peaq blockchain via the Electron Ledger Protocol (ELP).
Each HA instance represents one household / prosumer in a §42c EnWG cooperative.
"""
from __future__ import annotations

import logging

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ConfigEntryNotReady

from .const import DOMAIN, PLATFORMS
from .coordinator import ElectronChainCoordinator
from .peaq_client import PeaqClient, PeaqConnectionError

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up Electron Chain from a config entry."""
    hass.data.setdefault(DOMAIN, {})

    # Build the peaq client
    client = PeaqClient(
        rpc_url=entry.data["rpc_url"],
        wallet_seed=entry.data["wallet_seed"],
        did=entry.data["did"],
    )

    try:
        await client.async_connect()
    except PeaqConnectionError as err:
        raise ConfigEntryNotReady(f"peaq RPC not reachable: {err}") from err

    # Coordinator orchestrates: chain reads, MQTT hub talk, sensor updates
    coordinator = ElectronChainCoordinator(hass, entry, client)
    await coordinator.async_config_entry_first_refresh()
    await coordinator.async_start_hub_listener()
    await coordinator.async_register_with_hub()

    hass.data[DOMAIN][entry.entry_id] = coordinator

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)

    # Make sure we shut down cleanly
    entry.async_on_unload(entry.add_update_listener(_async_update_listener))

    _LOGGER.info(
        "Electron Chain ready for household=%s coop=%s did=%s",
        entry.data.get("household_id"),
        entry.data.get("cooperative_id"),
        entry.data.get("did"),
    )
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry."""
    unload_ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unload_ok:
        coordinator: ElectronChainCoordinator = hass.data[DOMAIN].pop(entry.entry_id)
        await coordinator.async_shutdown()
    return unload_ok


async def _async_update_listener(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Reload on options change."""
    await hass.config_entries.async_reload(entry.entry_id)
