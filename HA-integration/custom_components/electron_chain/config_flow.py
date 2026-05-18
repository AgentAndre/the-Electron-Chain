"""Config flow for Electron Chain.

Multi-step:
  1. user           — household + cooperative + chain creds
  2. adapter_pick   — autodiscovered list, user picks one
  3. adapter_bind   — confirm/edit the entity binding
"""
from __future__ import annotations

import logging
import uuid
from typing import Any

import voluptuous as vol

from homeassistant import config_entries
from homeassistant.core import callback
from homeassistant.helpers import selector

from .adapters import ADAPTER_REGISTRY, get_adapter
from .const import (
    CONF_ADAPTER_BINDING,
    CONF_ADAPTER_VENDOR,
    CONF_COOPERATIVE_ID,
    CONF_DID,
    CONF_HOUSEHOLD_ID,
    CONF_HUB_API_URL,
    CONF_HUB_URL,
    CONF_RPC_URL,
    CONF_WALLET_SEED,
    DEFAULT_HUB_API_URL,
    DEFAULT_HUB_URL,
    DEFAULT_RPC_URL,
    DOMAIN,
)

_LOGGER = logging.getLogger(__name__)

# Logical adapter slots that can be bound
BINDING_LOGICAL_KEYS = ("pv", "battery_soc", "battery_power", "grid_export", "home_load")


def _user_schema(defaults: dict[str, Any] | None = None) -> vol.Schema:
    d = defaults or {}
    return vol.Schema(
        {
            vol.Required(CONF_HOUSEHOLD_ID, default=d.get(CONF_HOUSEHOLD_ID, "")): str,
            vol.Required(CONF_COOPERATIVE_ID, default=d.get(CONF_COOPERATIVE_ID, "heutestadtmorgen")): str,
            vol.Required(CONF_RPC_URL, default=d.get(CONF_RPC_URL, DEFAULT_RPC_URL)): str,
            vol.Required(CONF_HUB_URL, default=d.get(CONF_HUB_URL, DEFAULT_HUB_URL)): str,
            vol.Required(CONF_HUB_API_URL, default=d.get(CONF_HUB_API_URL, DEFAULT_HUB_API_URL)): str,
            vol.Required(CONF_WALLET_SEED, default=d.get(CONF_WALLET_SEED, "")): str,
            vol.Required(CONF_DID, default=d.get(CONF_DID, "")): str,
        }
    )


class ElectronChainConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Handle initial setup."""

    VERSION = 2

    def __init__(self) -> None:
        self._collected: dict[str, Any] = {}
        self._discovered: dict[str, list[dict[str, str]]] = {}

    # ---------- step 1 ----------

    async def async_step_user(self, user_input=None) -> config_entries.FlowResult:
        errors: dict[str, str] = {}
        if user_input is not None:
            if not user_input.get(CONF_DID):
                user_input[CONF_DID] = f"did:peaq:{uuid.uuid4().hex[:24]}"
            if not user_input.get(CONF_WALLET_SEED):
                errors[CONF_WALLET_SEED] = "required"
            if not errors:
                self._collected.update(user_input)
                await self.async_set_unique_id(
                    f"{user_input[CONF_COOPERATIVE_ID]}::{user_input[CONF_HOUSEHOLD_ID]}"
                )
                self._abort_if_unique_id_configured()
                return await self.async_step_adapter_pick()

        return self.async_show_form(
            step_id="user", data_schema=_user_schema(user_input), errors=errors
        )

    # ---------- step 2 ----------

    async def async_step_adapter_pick(self, user_input=None) -> config_entries.FlowResult:
        # Run discovery for every adapter
        for vendor, cls in ADAPTER_REGISTRY.items():
            try:
                self._discovered[vendor] = cls.discover(self.hass)
            except Exception as err:  # noqa: BLE001
                _LOGGER.warning("Discovery failed for %s: %s", vendor, err)
                self._discovered[vendor] = []

        # Build a friendly label list
        options = []
        for vendor, cls in sorted(
            ADAPTER_REGISTRY.items(),
            key=lambda kv: (-kv[1].priority, kv[0]),
        ):
            n_found = len(self._discovered.get(vendor, []))
            label = f"{cls.model}"
            if n_found:
                label += f"  ✓ ({n_found} detected)"
            else:
                label += "  (manual)"
            options.append({"value": vendor, "label": label})

        if user_input is not None:
            self._collected[CONF_ADAPTER_VENDOR] = user_input[CONF_ADAPTER_VENDOR]
            return await self.async_step_adapter_bind()

        return self.async_show_form(
            step_id="adapter_pick",
            data_schema=vol.Schema(
                {
                    vol.Required(CONF_ADAPTER_VENDOR, default="generic"): selector.SelectSelector(
                        selector.SelectSelectorConfig(options=options, mode="dropdown")
                    )
                }
            ),
        )

    # ---------- step 3 ----------

    async def async_step_adapter_bind(self, user_input=None) -> config_entries.FlowResult:
        vendor = self._collected[CONF_ADAPTER_VENDOR]
        autodetected = (self._discovered.get(vendor) or [{}])[0]

        if user_input is not None:
            # Drop empty values so the adapter can fall back to defaults
            binding = {k: v for k, v in user_input.items() if v}
            self._collected[CONF_ADAPTER_BINDING] = binding
            return self.async_create_entry(
                title=f"ELP {self._collected[CONF_COOPERATIVE_ID]}/"
                      f"{self._collected[CONF_HOUSEHOLD_ID]}",
                data=self._collected,
            )

        # Build a per-logical-key entity selector
        schema_dict: dict = {}
        for key in BINDING_LOGICAL_KEYS:
            schema_dict[
                vol.Optional(key, default=autodetected.get(key, ""))
            ] = selector.EntitySelector(
                selector.EntitySelectorConfig(domain="sensor")
            )

        return self.async_show_form(
            step_id="adapter_bind",
            data_schema=vol.Schema(schema_dict),
            description_placeholders={
                "vendor": vendor,
                "model": get_adapter(vendor).model if get_adapter(vendor) else vendor,
                "n_detected": str(len(autodetected)),
            },
        )

    # ---------- options flow ----------

    @staticmethod
    @callback
    def async_get_options_flow(entry: config_entries.ConfigEntry) -> config_entries.OptionsFlow:
        return ElectronChainOptionsFlow(entry)


class ElectronChainOptionsFlow(config_entries.OptionsFlow):
    def __init__(self, entry: config_entries.ConfigEntry) -> None:
        self._entry = entry

    async def async_step_init(self, user_input=None) -> config_entries.FlowResult:
        if user_input is not None:
            return self.async_create_entry(title="", data=user_input)

        current = {**self._entry.data, **self._entry.options}
        binding_schema = {}
        current_binding = current.get(CONF_ADAPTER_BINDING, {})
        for key in BINDING_LOGICAL_KEYS:
            binding_schema[
                vol.Optional(key, default=current_binding.get(key, ""))
            ] = selector.EntitySelector(
                selector.EntitySelectorConfig(domain="sensor")
            )

        return self.async_show_form(
            step_id="init", data_schema=vol.Schema(binding_schema)
        )
