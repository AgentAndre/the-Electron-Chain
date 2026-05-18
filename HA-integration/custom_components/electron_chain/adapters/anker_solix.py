"""Anker Solix adapter.

Targets the community HACS integration `anker_solix` by @thomluther,
which exposes Solarbank E1600 / Solix series devices. Entity naming
follows the pattern `sensor.solarbank_<deviceid>_<metric>`.

Capabilities: PV + battery readout (no setpoint control via the cloud
integration; setpoint would require local Bluetooth, which is out of
scope for v0.1).
"""
from __future__ import annotations

from typing import ClassVar

from homeassistant.core import HomeAssistant

from .base import DeviceAdapter, DeviceReading
from .registry import register


@register
class AnkerSolixAdapter(DeviceAdapter):
    vendor: ClassVar[str] = "anker_solix"
    model: ClassVar[str] = "Solarbank E1600 / Solix Series"
    capabilities: ClassVar[set[str]] = {"pv", "battery"}
    priority: ClassVar[int] = 60

    @classmethod
    def discover(cls, hass: HomeAssistant) -> list[dict[str, str]]:
        # Group entities by device-id substring (the bit between solarbank_ and _metric)
        groups: dict[str, dict[str, str]] = {}
        for eid in hass.states.async_entity_ids("sensor"):
            obj = eid.split(".", 1)[1].lower()
            if not obj.startswith("solarbank_"):
                continue
            tail = obj[len("solarbank_"):]
            # tail looks like "<deviceid>_<metric>"; metric is the last suffix.
            for metric_suffix, logical in (
                ("_pv_power", "pv"),
                ("_solar_power", "pv"),
                ("_battery_soc", "battery_soc"),
                ("_battery_state_of_charge", "battery_soc"),
                ("_battery_power", "battery_power"),
                ("_output_power", "battery_power"),
                ("_grid_power", "grid_export"),
                ("_home_load", "home_load"),
            ):
                if tail.endswith(metric_suffix):
                    device_id = tail[: -len(metric_suffix)] or "default"
                    groups.setdefault(device_id, {})[logical] = eid
                    break
        return [g for g in groups.values() if g]

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
