"""peaq blockchain client.

Thin async wrapper around `substrate-interface` for the bits ELP needs:
  - Connect to a peaq RPC endpoint (Agung Testnet by default)
  - Read DID documents from the peaq-did pallet
  - Submit FlexibilityOffers via the peaq-storage pallet
  - Query block height for liveness checks

substrate-interface is sync internally, so we wrap calls in
`hass.async_add_executor_job` from the coordinator. This module exposes
synchronous methods marked `_sync` plus async-friendly wrappers.

NOTE: Concrete pallet/extrinsic names follow current peaq runtime
(Agung Testnet, Krest mainnet). Verify against current metadata; the
substrate-interface auto-loads metadata so naming changes are detectable
at runtime via clear errors.
"""
from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from typing import Any

from substrateinterface import SubstrateInterface, Keypair
from substrateinterface.exceptions import SubstrateRequestException

_LOGGER = logging.getLogger(__name__)


class PeaqConnectionError(Exception):
    """Raised when the peaq RPC is unreachable or the chain is unhealthy."""


class PeaqExtrinsicError(Exception):
    """Raised when an extrinsic submission fails on-chain."""


@dataclass
class FlexibilityOffer:
    """Represents one P2P energy offer."""

    offer_id: str               # uuid4 hex
    seller_did: str             # did:peaq:... of producer
    kwh: float                  # energy on offer
    price_ct_per_kwh: float     # asking price
    valid_until: int            # unix ts
    cooperative_id: str
    block_number: int | None = None  # filled in after on-chain submission
    extrinsic_hash: str | None = None

    def to_chain_payload(self) -> bytes:
        """Serialise to the bytes blob stored under peaq-storage."""
        return json.dumps(asdict(self), separators=(",", ":")).encode("utf-8")


class PeaqClient:
    """Async-friendly wrapper around SubstrateInterface."""

    def __init__(self, rpc_url: str, wallet_seed: str, did: str) -> None:
        self._rpc_url = rpc_url
        self._wallet_seed = wallet_seed
        self._did = did
        self._substrate: SubstrateInterface | None = None
        self._keypair: Keypair | None = None
        self._lock = asyncio.Lock()

    # ---------- lifecycle ----------

    async def async_connect(self) -> None:
        """Open the WebSocket connection in an executor thread."""
        try:
            await asyncio.get_running_loop().run_in_executor(
                None, self._connect_sync
            )
        except Exception as err:  # noqa: BLE001
            raise PeaqConnectionError(str(err)) from err

    def _connect_sync(self) -> None:
        self._substrate = SubstrateInterface(
            url=self._rpc_url,
            ss58_format=42,           # peaq uses generic Substrate prefix
            type_registry_preset="substrate-node-template",
        )
        # Sanity ping — fetches metadata
        chain = self._substrate.chain
        runtime = self._substrate.runtime_version
        _LOGGER.info("Connected to %s runtime=%s", chain, runtime)

        # Build keypair from seed/mnemonic (sr25519)
        self._keypair = Keypair.create_from_uri(self._wallet_seed)
        _LOGGER.debug("Loaded wallet ss58=%s", self._keypair.ss58_address)

    async def async_close(self) -> None:
        if self._substrate is not None:
            await asyncio.get_running_loop().run_in_executor(
                None, self._substrate.close
            )
            self._substrate = None

    # ---------- read paths ----------

    async def async_get_block_number(self) -> int:
        """Liveness probe — current finalized block height."""
        return await asyncio.get_running_loop().run_in_executor(
            None, self._get_block_number_sync
        )

    def _get_block_number_sync(self) -> int:
        assert self._substrate is not None
        head = self._substrate.get_chain_finalised_head()
        block = self._substrate.get_block(block_hash=head)
        return int(block["header"]["number"])

    async def async_read_did_document(self, did: str) -> dict[str, Any] | None:
        """Resolve a DID document via the peaq-did pallet."""
        return await asyncio.get_running_loop().run_in_executor(
            None, self._read_did_sync, did
        )

    def _read_did_sync(self, did: str) -> dict[str, Any] | None:
        assert self._substrate is not None
        try:
            # peaq-did pallet stores `AttributeStore`: (account, name) -> attribute
            # For a v0 ELP we treat the wallet ss58 as the DID controller and
            # store offers under storage_key = b"elp:offer:<id>".
            # A real DID-doc lookup would query `peaqDid::attributeStore`.
            result = self._substrate.query(
                module="PeaqDid",
                storage_function="AttributeStore",
                params=[self._keypair.ss58_address if self._keypair else "", did],
            )
            return result.value if result else None
        except SubstrateRequestException as err:
            _LOGGER.warning("DID lookup failed for %s: %s", did, err)
            return None

    # ---------- write paths ----------

    async def async_submit_offer(self, offer: FlexibilityOffer) -> FlexibilityOffer:
        """Persist a FlexibilityOffer via peaq-storage extrinsic.

        Uses `peaqStorage::add_item(key, value)` if the pallet is present;
        otherwise falls back to `peaqDid::add_attribute`.
        """
        async with self._lock:  # serialize submissions per client
            return await asyncio.get_running_loop().run_in_executor(
                None, self._submit_offer_sync, offer
            )

    def _submit_offer_sync(self, offer: FlexibilityOffer) -> FlexibilityOffer:
        assert self._substrate is not None and self._keypair is not None
        storage_key = f"elp:offer:{offer.offer_id}".encode("utf-8")
        payload = offer.to_chain_payload()

        # Compose the call. We try peaq-storage first, fall back to peaq-did.
        try:
            call = self._substrate.compose_call(
                call_module="PeaqStorage",
                call_function="add_item",
                call_params={"item_type": storage_key, "item": payload},
            )
        except Exception:  # noqa: BLE001 — pallet may not exist on this runtime
            _LOGGER.debug("PeaqStorage not available — using peaq-did attribute")
            call = self._substrate.compose_call(
                call_module="PeaqDid",
                call_function="add_attribute",
                call_params={
                    "did_account": self._keypair.ss58_address,
                    "name": storage_key,
                    "value": payload,
                    "valid_for": None,
                },
            )

        extrinsic = self._substrate.create_signed_extrinsic(
            call=call, keypair=self._keypair
        )
        try:
            receipt = self._substrate.submit_extrinsic(
                extrinsic, wait_for_inclusion=True
            )
        except SubstrateRequestException as err:
            raise PeaqExtrinsicError(str(err)) from err

        if not receipt.is_success:
            raise PeaqExtrinsicError(
                f"Extrinsic failed: {receipt.error_message}"
            )

        offer.block_number = receipt.block_number
        offer.extrinsic_hash = receipt.extrinsic_hash
        _LOGGER.info(
            "Offer %s anchored block=%s tx=%s",
            offer.offer_id,
            offer.block_number,
            offer.extrinsic_hash,
        )
        return offer

    @property
    def ss58_address(self) -> str:
        return self._keypair.ss58_address if self._keypair else ""

    @property
    def wallet_did(self) -> str:
        return self._did

    @property
    def is_connected(self) -> bool:
        return self._substrate is not None
