"""Switch to enable/disable trading per household."""
from __future__ import annotations

from typing import Any

from homeassistant.components.switch import SwitchEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN
from .coordinator import ElectronChainCoordinator


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    coordinator: ElectronChainCoordinator = hass.data[DOMAIN][entry.entry_id]
    async_add_entities([TradingSwitch(coordinator, entry)])


class TradingSwitch(CoordinatorEntity[ElectronChainCoordinator], SwitchEntity):
    """Master switch — when off, no offers are posted to chain."""

    _attr_has_entity_name = True
    _attr_translation_key = "trading_enabled"
    _attr_icon = "mdi:swap-horizontal"

    def __init__(
        self,
        coordinator: ElectronChainCoordinator,
        entry: ConfigEntry,
    ) -> None:
        super().__init__(coordinator)
        self._attr_unique_id = f"{entry.entry_id}_trading_enabled"
        self._attr_device_info = {
            "identifiers": {(DOMAIN, entry.entry_id)},
            "name": f"Electron Chain · {entry.data.get('household_id')}",
            "manufacturer": "heutestadtmorgen eG",
            "model": "ELP Node",
            "sw_version": "0.1.0",
        }

    @property
    def is_on(self) -> bool:
        return self.coordinator.trading_enabled

    async def async_turn_on(self, **kwargs: Any) -> None:
        self.coordinator.set_trading(True)
        self.async_write_ha_state()

    async def async_turn_off(self, **kwargs: Any) -> None:
        self.coordinator.set_trading(False)
        self.async_write_ha_state()
