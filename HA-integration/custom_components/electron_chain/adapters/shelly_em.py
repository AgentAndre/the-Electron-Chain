"""Shelly 3EM / Pro 3EM adapter.

Targets the official `shelly` integration. Devices commonly named
`sensor.shellyem3_<id>_total_active_power` or
`sensor.shellypro3em_<id>_total_active_power`.

This adapter ONLY provides grid measurement — it has no battery or
PV. Use it together with another adapter (combined via the
`CompositeAdapter` in coordinator) when the user has, say, an Anker
Solix and a separate Shelly 3EM at the meter.

Sign convention assumed: positive = import. We flip to match our
"grid_export_w > 0 means selling" convention.
"""
from __future__ import annotations

from typing import ClassVar

from homeassistant.core import HomeAssistant

from .base import DeviceAdapter, DeviceReading
from .registry import register


@register
class Shelly3EMAdapter(DeviceAdapter):
    vendor: ClassVar[str] = "shelly_3em"
    model: ClassVar[str] = "Shelly 3EM / Pro 3EM"
    capabilities: ClassVar[set[str]] = {"grid"}
    priority: ClassVar[int] = 40  # lower — gets used as grid supplement

    _SUBSTRINGS: ClassVar[tuple[tuple[str, ...], ...]] = (
        ("shellyem3", "total", "active", "power"),
        ("shellypro3em", "total", "active", "power"),
        ("shelly3em", "total", "power"),
    )

    @classmethod
    def discover(cls, hass: HomeAssistant) -> list[dict[str, str]]:
        for substrings in cls._SUBSTRINGS:
            for eid in hass.states.async_entity_ids("sensor"):
                obj = eid.split(".", 1)[1].lower()
                if all(s in obj for s in substrings):
                    return [{"grid_import_signed": eid}]
        return []

    def read_state(self, hass: HomeAssistant) -> DeviceReading:
        signed = self._read_float(hass, self._overrides.get("grid_import_signed"))
        export = -signed if signed is not None else None
        return DeviceReading(
            grid_export_w=export,
            source_vendor=self.vendor,
            source_model=self.model,
        )
