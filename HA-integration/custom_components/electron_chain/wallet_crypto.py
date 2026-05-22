"""Fernet wallet-seed encryption for the integration.

The peaq wallet seed is high-value material: it controls on-chain identity
and signed offer extrinsics. Storing it as plaintext under HA's
`.storage/core.config_entries` is a known v0.2 limitation called out in
the integration README — this module is the fix for it.

How it's used:
  - On first setup the user supplies a passphrase. We derive a Fernet key
    via PBKDF2-HMAC-SHA256 (480k iterations, OWASP 2023+), wrap the seed,
    and persist only the ciphertext + KDF parameters in the config entry.
  - On every HA restart the integration needs the passphrase again to
    decrypt the seed before the peaq client can sign. The passphrase is
    requested via a re-auth flow (cf. `config_flow.py`) and lives in
    process memory only.

The format mirrors `rootfs/app/wallet_crypto.py` on the addon side so a
seed wrapped by either component can be unwrapped by the other.
"""
from __future__ import annotations

import base64
import os
from dataclasses import dataclass
from typing import Any

from cryptography.fernet import Fernet, InvalidToken
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

KDF_NAME = "pbkdf2-sha256"
KDF_ITERATIONS = 480_000
SALT_BYTES = 16
VERIFIER_MAGIC = b"elp-vault-v1"


class VaultError(Exception):
    """Raised for any unlock or encryption failure."""


class WrongPassphrase(VaultError):
    """Passphrase did not match the stored verifier."""


@dataclass(frozen=True)
class EncryptedSecret:
    kdf: str
    salt_b64: str
    iterations: int
    ciphertext_b64: str
    verifier_b64: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "kdf": self.kdf,
            "salt_b64": self.salt_b64,
            "iterations": self.iterations,
            "ciphertext_b64": self.ciphertext_b64,
            "verifier_b64": self.verifier_b64,
        }

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> "EncryptedSecret":
        return cls(
            kdf=raw["kdf"],
            salt_b64=raw["salt_b64"],
            iterations=int(raw["iterations"]),
            ciphertext_b64=raw["ciphertext_b64"],
            verifier_b64=raw["verifier_b64"],
        )


def _derive_key(passphrase: str, salt: bytes, iterations: int) -> bytes:
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=32,
        salt=salt,
        iterations=iterations,
    )
    raw = kdf.derive(passphrase.encode("utf-8"))
    return base64.urlsafe_b64encode(raw)


def encrypt_secret(plaintext: str, passphrase: str) -> EncryptedSecret:
    if not plaintext:
        raise VaultError("Empty plaintext")
    if not passphrase or len(passphrase) < 6:
        raise VaultError("Passphrase too short (min 6 chars)")

    salt = os.urandom(SALT_BYTES)
    key = _derive_key(passphrase, salt, KDF_ITERATIONS)
    fernet = Fernet(key)
    return EncryptedSecret(
        kdf=KDF_NAME,
        salt_b64=base64.urlsafe_b64encode(salt).decode("ascii"),
        iterations=KDF_ITERATIONS,
        ciphertext_b64=fernet.encrypt(plaintext.encode("utf-8")).decode("ascii"),
        verifier_b64=fernet.encrypt(VERIFIER_MAGIC).decode("ascii"),
    )


def decrypt_secret(enc: EncryptedSecret, passphrase: str) -> str:
    if enc.kdf != KDF_NAME:
        raise VaultError(f"Unsupported KDF: {enc.kdf}")

    salt = base64.urlsafe_b64decode(enc.salt_b64.encode("ascii"))
    key = _derive_key(passphrase, salt, enc.iterations)
    fernet = Fernet(key)

    try:
        verified = fernet.decrypt(enc.verifier_b64.encode("ascii"))
    except InvalidToken as err:
        raise WrongPassphrase("Wrong passphrase") from err
    if verified != VERIFIER_MAGIC:
        raise WrongPassphrase("Verifier mismatch")

    try:
        return fernet.decrypt(enc.ciphertext_b64.encode("ascii")).decode("utf-8")
    except InvalidToken as err:
        raise VaultError("Ciphertext corrupted") from err
