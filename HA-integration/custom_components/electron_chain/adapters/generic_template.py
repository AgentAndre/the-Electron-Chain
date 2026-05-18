"""Generic / template adapter.

Last-resort fallback that lets the user manually pin any sensor entities.
Discovers nothing automatically — only used when the user picks "Generic"
in the config flow and provides explicit entity IDs.

Also serves the simulation entities created by the bootstrap script:
`sensor.sim_pv_power`, `sensor.sim_battery_power`, `sensor.sim_grid_export`.
"""
from __future__ import annotations

from typing import ClassVar

from homeassistant.core import HomeAssistant

from .base import DeviceAdapter, DeviceReading
from .registry import register


@register
class GenericAdapter(DeviceAdapter):
    vendor: ClassVar[str] = "generic"
    model: ClassVar[str] = "Generic / Manual"
    capabilities: ClassVar[set[str]] = {"pv", "battery", "grid"}
    priority: ClassVar[int] = 1  # lowest — only chosen when nothing else fits

    @classmethod
    def discover(cls, hass: HomeAssistant) -> list[dict[str, str]]:
        # Special-case: detect the bootstrap simulation entities
        sim_entities = {
            "pv": "sensor.sim_pv_power",
            "battery_power": "sensor.sim_battery_power",
            "grid_export": "sensor.sim_grid_export",
        }
        if all(
            hass.states.get(eid) is not None
            for eid in sim_entities.values()
        ):
            return [sim_entities]
        return []

    def read_state(self, hass: HomeAssistant) -> DeviceReading:
        return DeviceReading(
            pv_power_w=self._read_float(hass, self._overrides.get("pv")),
            battery_soc_pct=self._read_float(hass, self._overrides.get("battery_soc")),
            battery_power_w=self._read_float(hass, self._overrides.get("battery_power")),
            grid_export_w=self._read_float(hass, self._overrides.get("grid_export")),
            home_load_w=self._read_float(hass, self._overrides.get("home_load")),
            source_vendor=self.vendor,
            source_model=self.model,
        )
