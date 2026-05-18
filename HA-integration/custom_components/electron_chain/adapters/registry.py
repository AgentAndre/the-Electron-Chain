"""Adapter registry with decorator-based registration."""
from __future__ import annotations

import logging
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .base import DeviceAdapter

_LOGGER = logging.getLogger(__name__)

ADAPTER_REGISTRY: dict[str, type["DeviceAdapter"]] = {}


def register(cls: type["DeviceAdapter"]) -> type["DeviceAdapter"]:
    """Class decorator: registers the adapter under its `vendor` key."""
    if not cls.vendor:
        raise ValueError(f"Adapter {cls.__name__} has no vendor key")
    if cls.vendor in ADAPTER_REGISTRY:
        _LOGGER.warning("Adapter vendor=%s already registered, overwriting", cls.vendor)
    ADAPTER_REGISTRY[cls.vendor] = cls
    return cls


def get_adapter(vendor: str) -> type["DeviceAdapter"] | None:
    return ADAPTER_REGISTRY.get(vendor)


def list_adapters() -> list[dict]:
    return [cls.info() for cls in ADAPTER_REGISTRY.values()]
