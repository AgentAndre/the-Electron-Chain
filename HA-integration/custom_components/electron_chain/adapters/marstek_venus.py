"""Marstek Venus E (Gen 2 / Gen 3) adapter.

Targets the HACS community integration `marstek` (also published as
`marstek_venus_modbus`) which exposes the Venus E via Modbus TCP.
Entity naming pattern: `sensor.marstek_<metric>` or
`sensor.venus_<metric>` depending on integration variant.

Capabilities: PV + battery + setpoint (Modbus write supported).
"""
from __future__ import annotations

import logging
from typing import ClassVar

from homeassistant.core import HomeAssistant

from .base import DeviceAdapter, DeviceReading
from .registry import register

_LOGGER = logging.getLogger(__name__)


@register
class MarstekVenusAdapter(DeviceAdapter):
    vendor: ClassVar[str] = "marstek_venus"
    model: ClassVar[str] = "Marstek Venus E (Gen 2/3)"
    capabilities: ClassVar[set[str]] = {"pv", "battery", "controllable"}
    priority: ClassVar[int] = 65

    _PREFIXES: ClassVar[tuple[str, ...]] = ("marstek_", "venus_")

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
                ("battery_soc", "battery_soc"),
                ("soc", "battery_soc"),
                ("battery_power", "battery_power"),
                ("charge_discharge_power", "battery_power"),
                ("grid_power", "grid_export"),
                ("ac_power", "grid_export"),
                ("load_power", "home_load"),
            ):
                if token in obj and logical not in binding:
                    binding[logical] = eid
                    break
        return [binding] if binding else []

    def read_state(self, hass: HomeAssistant) -> DeviceReading:
        # Marstek Modbus integration uses positive values for charging,
        # negative for discharging — matches our convention. Grid power
        # however is typically signed: positive = import. Flip sign.
        grid_raw = self._read_float(hass, self._overrides.get("grid_export"))
        grid_export = -grid_raw if grid_raw is not None else None

        return DeviceReading(
            pv_power_w=self._read_float(hass, self._overrides.get("pv")),
            battery_soc_pct=self._read_float(hass, self._overrides.get("battery_soc")),
            battery_power_w=self._read_float(hass, self._overrides.get("battery_power")),
            grid_export_w=grid_export,
            home_load_w=self._read_float(hass, self._overrides.get("home_load")),
            source_vendor=self.vendor,
            source_model=self.model,
        )

    async def set_battery_setpoint_w(
        self, hass: HomeAssistant, watts: int
    ) -> bool:
        """Issue a Modbus write via the marstek service.

        The community integration exposes
        `marstek.set_charge_discharge_power` (or similar). We try both names.
        """
        for service in ("set_charge_discharge_power", "set_battery_setpoint"):
            if hass.services.has_service("marstek", service):
                await hass.services.async_call(
                    "marstek",
                    service,
                    {"power": int(watts)},
                    blocking=False,
                )
                return True
        _LOGGER.warning("No marstek setpoint service registered")
        return False
