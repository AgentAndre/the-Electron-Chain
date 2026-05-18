"""Maxxicharge 3.0 / Maxxisun adapter.

Targets the community integration `maxxisun` which exposes Maxxicharge
units (battery + PV combined). Entity naming pattern:
`sensor.maxxi_<metric>` or `sensor.maxxicharge_<metric>`.

Capabilities: PV + battery + setpoint via service call.
"""
from __future__ import annotations

import logging
from typing import ClassVar

from homeassistant.core import HomeAssistant

from .base import DeviceAdapter, DeviceReading
from .registry import register

_LOGGER = logging.getLogger(__name__)


@register
class MaxxichargeAdapter(DeviceAdapter):
    vendor: ClassVar[str] = "maxxicharge"
    model: ClassVar[str] = "Maxxicharge 3.0"
    capabilities: ClassVar[set[str]] = {"pv", "battery", "controllable"}
    priority: ClassVar[int] = 65

    _PREFIXES: ClassVar[tuple[str, ...]] = ("maxxi_", "maxxicharge_", "maxxisun_")

    @classmethod
    def discover(cls, hass: HomeAssistant) -> list[dict[str, str]]:
        binding: dict[str, str] = {}
        for eid in hass.states.async_entity_ids("sensor"):
            obj = eid.split(".", 1)[1].lower()
            if not any(obj.startswith(p) for p in cls._PREFIXES):
                continue
            for token, logical in (
                ("pv_power", "pv"),
                ("solar_power", "pv"),
                ("input_power", "pv"),
                ("soc", "battery_soc"),
                ("battery_level", "battery_soc"),
                ("battery_power", "battery_power"),
                ("output_power", "battery_power"),
                ("grid_power", "grid_export"),
                ("export_power", "grid_export"),
                ("home_consumption", "home_load"),
                ("load", "home_load"),
            ):
                if token in obj and logical not in binding:
                    binding[logical] = eid
                    break
        return [binding] if binding else []

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

    async def set_battery_setpoint_w(
        self, hass: HomeAssistant, watts: int
    ) -> bool:
        for domain in ("maxxisun", "maxxicharge"):
            if hass.services.has_service(domain, "set_output_power"):
                await hass.services.async_call(
                    domain, "set_output_power", {"power": int(watts)}, blocking=False
                )
                return True
        _LOGGER.warning("No Maxxicharge setpoint service registered")
        return False
