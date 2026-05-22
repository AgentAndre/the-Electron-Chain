"""Constants for the Electron Chain integration."""
from __future__ import annotations

from typing import Final

DOMAIN: Final = "electron_chain"
PLATFORMS: Final = ["sensor", "switch"]

# Config keys — wallet / chain
CONF_DID: Final = "did"
CONF_RPC_URL: Final = "rpc_url"
CONF_HUB_URL: Final = "hub_url"
CONF_HUB_API_URL: Final = "hub_api_url"
CONF_WALLET_SEED: Final = "wallet_seed"                # plaintext (transient, never persisted)
CONF_WALLET_SEED_ENC: Final = "wallet_seed_enc"        # Fernet-wrapped seed (persisted)
CONF_WALLET_PASSPHRASE: Final = "wallet_passphrase"    # user input only, never persisted
CONF_HOUSEHOLD_ID: Final = "household_id"
CONF_COOPERATIVE_ID: Final = "cooperative_id"

# Config keys — device adapter
CONF_ADAPTER_VENDOR: Final = "adapter_vendor"
CONF_ADAPTER_BINDING: Final = "adapter_binding"

# Defaults
DEFAULT_RPC_URL: Final = "wss://wsspc1-qa.agung.peaq.network"
DEFAULT_HUB_URL: Final = "mqtt://localhost:1883"
DEFAULT_HUB_API_URL: Final = "http://elp-hub:8000"
DEFAULT_UPDATE_INTERVAL_SEC: Final = 30
DEFAULT_OFFER_INTERVAL_SEC: Final = 60
DEFAULT_MIN_SURPLUS_W: Final = 100

# MQTT Topics
TOPIC_PREFIX: Final = "elp"
TOPIC_OFFER_PUBLISH: Final = "elp/{coop}/offers/publish"
TOPIC_OFFER_BOOK: Final = "elp/{coop}/offers/book"
TOPIC_MATCH: Final = "elp/{coop}/match/{household}"
TOPIC_SETTLEMENT: Final = "elp/{coop}/settlement/{household}"
TOPIC_GRID_PRICE: Final = "elp/{coop}/grid/price"
TOPIC_HOUSEHOLD_HEARTBEAT: Final = "elp/{coop}/heartbeat/{household}"

# Coordinator state-dict keys
STATE_STATUS: Final = "status"
STATE_SURPLUS_W: Final = "surplus_w"
STATE_PV_W: Final = "pv_w"
STATE_BATTERY_SOC: Final = "battery_soc"
STATE_OFFER_ID: Final = "offer_id"
STATE_OFFER_PRICE: Final = "offer_price_ct_kwh"
STATE_LAST_MATCH: Final = "last_match"
STATE_TRADED_KWH_TODAY: Final = "traded_kwh_today"
STATE_REVENUE_TODAY: Final = "revenue_today_ct"
STATE_DID: Final = "did"
STATE_CHAIN_BLOCK: Final = "chain_block"
STATE_ADAPTER: Final = "adapter"

# Status enum
STATUS_IDLE: Final = "idle"
STATUS_OFFERING: Final = "offering"
STATUS_MATCHED: Final = "matched"
STATUS_CONSUMING: Final = "consuming"
STATUS_ERROR: Final = "error"
STATUS_DISCONNECTED: Final = "disconnected"
STATUS_NO_DEVICE: Final = "no_device"
