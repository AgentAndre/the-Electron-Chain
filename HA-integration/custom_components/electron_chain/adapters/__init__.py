"""Device adapters for Electron Chain.

Each adapter knows how to read state from one vendor's HA integration
(Anker Solix, Marstek Venus, Maxxicharge, Shelly 3EM, ...) and exposes
a unified `DeviceReading` to the coordinator.

To add a new vendor: drop a new file `adapters/<vendor>.py`, subclass
`DeviceAdapter`, decorate with `@register`. No coordinator change needed.
"""
from __future__ import annotations

from .base import DeviceAdapter, DeviceReading
from .registry import ADAPTER_REGISTRY, get_adapter, register

# Import all adapters so the registry populates on package import
from . import anker_solix  # noqa: F401
from . import marstek_venus  # noqa: F401
from . import maxxicharge  # noqa: F401
from . import shelly_em  # noqa: F401
from . import generic_template  # noqa: F401

__all__ = [
    "ADAPTER_REGISTRY",
    "DeviceAdapter",
    "DeviceReading",
    "get_adapter",
    "register",
]
