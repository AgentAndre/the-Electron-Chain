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
    CONF_WALLET_PASSPHRASE,
    CONF_WALLET_SEED,
    CONF_WALLET_SEED_ENC,
    DEFAULT_HUB_API_URL,
    DEFAULT_HUB_URL,
    DEFAULT_RPC_URL,
    DOMAIN,
)
from .wallet_crypto import (
    EncryptedSecret,
    VaultError,
    WrongPassphrase,
    decrypt_secret,
    encrypt_secret,
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
            vol.Required(CONF_WALLET_PASSPHRASE, default=""): str,
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
            passphrase = user_input.get(CONF_WALLET_PASSPHRASE, "")
            if len(passphrase) < 6:
                errors[CONF_WALLET_PASSPHRASE] = "too_short"

            if not errors:
                # Wrap the seed before it ever lands on disk; throw away both
                # the plaintext seed and the passphrase as soon as we're done.
                try:
                    enc = encrypt_secret(
                        user_input[CONF_WALLET_SEED], passphrase
                    )
                except VaultError as err:
                    _LOGGER.error("Seed encryption failed: %s", err)
                    errors["base"] = "encryption_failed"
                else:
                    persisted = {
                        k: v for k, v in user_input.items()
                        if k not in (CONF_WALLET_SEED, CONF_WALLET_PASSPHRASE)
                    }
                    persisted[CONF_WALLET_SEED_ENC] = enc.to_dict()
                    self._collected.update(persisted)
                    # Keep the plaintext seed in flow-local memory so the
                    # adapter/binding steps still work for this single setup
                    # session; it never reaches the config entry on disk.
                    self._collected["_seed_plaintext"] = user_input[CONF_WALLET_SEED]

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
            # Strip the plaintext-seed cache before writing to disk — only the
            # Fernet-wrapped blob is allowed to be persisted.
            self._collected.pop("_seed_plaintext", None)
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

    # ---------- reauth (passphrase prompt after restart) ----------

    async def async_step_reauth(self, entry_data) -> config_entries.FlowResult:
        """Triggered by __init__ when the seed needs unwrapping again."""
        self._collected = dict(entry_data)
        return await self.async_step_reauth_confirm()

    async def async_step_reauth_confirm(
        self, user_input=None
    ) -> config_entries.FlowResult:
        errors: dict[str, str] = {}
        enc_raw = self._collected.get(CONF_WALLET_SEED_ENC)
        if not enc_raw:
            return self.async_abort(reason="no_encrypted_seed")

        if user_input is not None:
            try:
                enc = EncryptedSecret.from_dict(enc_raw)
                seed = decrypt_secret(enc, user_input[CONF_WALLET_PASSPHRASE])
            except WrongPassphrase:
                errors[CONF_WALLET_PASSPHRASE] = "wrong_passphrase"
            except VaultError as err:
                _LOGGER.error("Vault unlock failed: %s", err)
                errors["base"] = "decryption_failed"
            else:
                # Stash the unlocked seed in hass.data so __init__ can pick
                # it up without it ever hitting the persisted config entry.
                from .const import DOMAIN as _D
                self.hass.data.setdefault(_D, {}).setdefault("_seeds", {})[
                    self.context.get("entry_id", "")
                ] = seed
                existing_entry = self.hass.config_entries.async_get_entry(
                    self.context.get("entry_id", "")
                )
                if existing_entry:
                    self.hass.config_entries.async_update_entry(existing_entry)
                return self.async_abort(reason="reauth_successful")

        return self.async_show_form(
            step_id="reauth_confirm",
            data_schema=vol.Schema({vol.Required(CONF_WALLET_PASSPHRASE): str}),
            errors=errors,
            description_placeholders={
                "household": self._collected.get(CONF_HOUSEHOLD_ID, "?"),
                "coop": self._collected.get(CONF_COOPERATIVE_ID, "?"),
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
