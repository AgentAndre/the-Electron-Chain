"""Base classes for device adapters."""
from __future__ import annotations

import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, ClassVar

from homeassistant.core import HomeAssistant

_LOGGER = logging.getLogger(__name__)


@dataclass
class DeviceReading:
    """Unified energy snapshot, normalized across vendors.

    Sign convention (consistent with VDE-AR-N 4105 metering):
      * battery_power_w  > 0  → charging
      * battery_power_w  < 0  → discharging
      * grid_export_w    > 0  → exporting to grid
      * grid_export_w    < 0  → importing from grid
    """

    pv_power_w: float | None = None
    battery_soc_pct: float | None = None
    battery_power_w: float | None = None
    grid_export_w: float | None = None
    home_load_w: float | None = None
    timestamp: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    source_vendor: str = ""
    source_model: str = ""
    raw: dict[str, Any] = field(default_factory=dict)

    def surplus_w(self) -> float:
        """Net surplus available for trading (positive = sellable)."""
        if self.grid_export_w is not None:
            return self.grid_export_w
        if self.pv_power_w is not None and self.home_load_w is not None:
            charging = max(self.battery_power_w or 0.0, 0.0)
            return self.pv_power_w - self.home_load_w - charging
        return 0.0

    def is_complete_enough_to_trade(self) -> bool:
        """Minimum data we need to even consider posting an offer."""
        return self.grid_export_w is not None or self.pv_power_w is not None


class DeviceAdapter(ABC):
    """Vendor-specific binding to HA entities.

    Subclasses must declare class-level metadata and implement
    `discover()` + `read_state()`.
    """

    vendor: ClassVar[str] = ""
    model: ClassVar[str] = ""
    capabilities: ClassVar[set[str]] = set()
    # Capabilities: any subset of {"pv", "battery", "grid", "controllable"}
    priority: ClassVar[int] = 50
    # Higher priority adapters win when multiple match (e.g. Shelly + Anker)

    def __init__(self, entity_overrides: dict[str, str] | None = None) -> None:
        """`entity_overrides` lets the user pin specific entities,
        bypassing autodiscovery. Keys: pv, battery_soc, battery_power,
        grid_export, home_load."""
        self._overrides = entity_overrides or {}
        self._cached_entities: dict[str, str] = {}

    # ---------- mandatory ----------

    @classmethod
    @abstractmethod
    def discover(cls, hass: HomeAssistant) -> list[dict[str, str]]:
        """Return one binding-dict per device instance found in this HA.

        Each binding-dict maps adapter logical names → HA entity_ids,
        e.g. {"pv": "sensor.solarbank_pv", "battery_soc": "sensor.solarbank_soc"}.
        Empty list = no compatible device on this HA.
        """

    @abstractmethod
    def read_state(self, hass: HomeAssistant) -> DeviceReading:
        """Read the current state. Called from coordinator's executor."""

    # ---------- optional ----------

    async def set_battery_setpoint_w(
        self, hass: HomeAssistant, watts: int
    ) -> bool:
        """Try to dispatch the battery. Default: not controllable."""
        _LOGGER.debug("%s: setpoint requested but adapter is read-only", self.vendor)
        return False

    # ---------- helpers ----------

    def _resolve(self, logical: str, autodetected: str | None) -> str | None:
        """Pick the entity_id: explicit override wins over autodiscovery."""
        return self._overrides.get(logical) or autodetected

    @staticmethod
    def _read_float(hass: HomeAssistant, entity_id: str | None) -> float | None:
        if not entity_id:
            return None
        state = hass.states.get(entity_id)
        if state is None or state.state in ("unknown", "unavailable", None, ""):
            return None
        try:
            return float(state.state)
        except (TypeError, ValueError):
            return None

    @staticmethod
    def _find_first(hass: HomeAssistant, *substrings: str) -> str | None:
        """Find the first entity_id whose object_id contains all substrings."""
        for entity_id in hass.states.async_entity_ids("sensor"):
            obj_id = entity_id.split(".", 1)[1].lower()
            if all(s.lower() in obj_id for s in substrings):
                return entity_id
        return None

    @classmethod
    def info(cls) -> dict[str, Any]:
        return {
            "vendor": cls.vendor,
            "model": cls.model,
            "capabilities": sorted(cls.capabilities),
            "priority": cls.priority,
        }
