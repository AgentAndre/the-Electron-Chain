"""Sensor entities for Electron Chain."""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from homeassistant.components.sensor import (
    SensorDeviceClass,
    SensorEntity,
    SensorEntityDescription,
    SensorStateClass,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import PERCENTAGE, UnitOfEnergy, UnitOfPower
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import (
    DOMAIN,
    STATE_ADAPTER,
    STATE_BATTERY_SOC,
    STATE_CHAIN_BLOCK,
    STATE_DID,
    STATE_OFFER_ID,
    STATE_OFFER_PRICE,
    STATE_PV_W,
    STATE_REVENUE_TODAY,
    STATE_STATUS,
    STATE_SURPLUS_W,
    STATE_TRADED_KWH_TODAY,
)
from .coordinator import ElectronChainCoordinator


@dataclass(frozen=True, kw_only=True)
class ElpSensorDescription(SensorEntityDescription):
    """Adds a value extractor on top of the standard description."""
    value_fn: Callable[[dict[str, Any]], Any]


SENSOR_DESCRIPTIONS: tuple[ElpSensorDescription, ...] = (
    ElpSensorDescription(
        key="status",
        translation_key="status",
        icon="mdi:lan-connect",
        value_fn=lambda d: d.get(STATE_STATUS),
    ),
    ElpSensorDescription(
        key="surplus",
        translation_key="surplus",
        native_unit_of_measurement=UnitOfPower.WATT,
        device_class=SensorDeviceClass.POWER,
        state_class=SensorStateClass.MEASUREMENT,
        value_fn=lambda d: d.get(STATE_SURPLUS_W),
    ),
    ElpSensorDescription(
        key="pv_power",
        translation_key="pv_power",
        native_unit_of_measurement=UnitOfPower.WATT,
        device_class=SensorDeviceClass.POWER,
        state_class=SensorStateClass.MEASUREMENT,
        value_fn=lambda d: d.get(STATE_PV_W),
    ),
    ElpSensorDescription(
        key="battery_soc",
        translation_key="battery_soc",
        native_unit_of_measurement=PERCENTAGE,
        device_class=SensorDeviceClass.BATTERY,
        state_class=SensorStateClass.MEASUREMENT,
        value_fn=lambda d: d.get(STATE_BATTERY_SOC),
    ),
    ElpSensorDescription(
        key="offer_id",
        translation_key="offer_id",
        icon="mdi:identifier",
        value_fn=lambda d: d.get(STATE_OFFER_ID),
    ),
    ElpSensorDescription(
        key="offer_price",
        translation_key="offer_price",
        native_unit_of_measurement="ct/kWh",
        state_class=SensorStateClass.MEASUREMENT,
        value_fn=lambda d: d.get(STATE_OFFER_PRICE),
    ),
    ElpSensorDescription(
        key="traded_kwh_today",
        translation_key="traded_kwh_today",
        native_unit_of_measurement=UnitOfEnergy.KILO_WATT_HOUR,
        device_class=SensorDeviceClass.ENERGY,
        state_class=SensorStateClass.TOTAL_INCREASING,
        value_fn=lambda d: d.get(STATE_TRADED_KWH_TODAY),
    ),
    ElpSensorDescription(
        key="revenue_today",
        translation_key="revenue_today",
        native_unit_of_measurement="ct",
        state_class=SensorStateClass.TOTAL_INCREASING,
        value_fn=lambda d: d.get(STATE_REVENUE_TODAY),
    ),
    ElpSensorDescription(
        key="did",
        translation_key="did",
        icon="mdi:fingerprint",
        value_fn=lambda d: d.get(STATE_DID),
    ),
    ElpSensorDescription(
        key="adapter",
        translation_key="adapter",
        icon="mdi:chip",
        value_fn=lambda d: d.get(STATE_ADAPTER),
    ),
    ElpSensorDescription(
        key="chain_block",
        translation_key="chain_block",
        icon="mdi:link-variant",
        state_class=SensorStateClass.MEASUREMENT,
        value_fn=lambda d: d.get(STATE_CHAIN_BLOCK),
    ),
)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    coordinator: ElectronChainCoordinator = hass.data[DOMAIN][entry.entry_id]
    async_add_entities(
        ElectronChainSensor(coordinator, entry, desc)
        for desc in SENSOR_DESCRIPTIONS
    )


class ElectronChainSensor(CoordinatorEntity[ElectronChainCoordinator], SensorEntity):
    """One sensor backed by the coordinator's state dict."""

    _attr_has_entity_name = True
    entity_description: ElpSensorDescription

    def __init__(
        self,
        coordinator: ElectronChainCoordinator,
        entry: ConfigEntry,
        description: ElpSensorDescription,
    ) -> None:
        super().__init__(coordinator)
        self.entity_description = description
        self._attr_unique_id = f"{entry.entry_id}_{description.key}"
        self._attr_device_info = {
            "identifiers": {(DOMAIN, entry.entry_id)},
            "name": f"Electron Chain · {entry.data.get('household_id')}",
            "manufacturer": "heutestadtmorgen eG",
            "model": "ELP Node",
            "sw_version": "0.2.0",
        }

    @property
    def native_value(self) -> Any:
        if self.coordinator.data is None:
            return None
        return self.entity_description.value_fn(self.coordinator.data)
