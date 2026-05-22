"""Fernet wallet-seed encryption.

Wraps an arbitrary secret (typically a peaq wallet seed phrase) with Fernet
(AES-128-CBC + HMAC-SHA256, authenticated). The Fernet key is derived from
a user passphrase via PBKDF2-HMAC-SHA256 with a per-secret salt.

Threat model:
  - The /data volume on a HA Supervisor host is reachable to anyone with
    host filesystem access. Plaintext seed phrases there are a known v0.2
    limitation called out in the integration README. This module is the
    fix for it.
  - The passphrase is supplied by the user at unlock time and lives in
    process memory only — it is never written to disk.
  - The verifier blob lets the API confirm a wrong passphrase *before*
    attempting to decrypt the real ciphertext, so we don't surface
    InvalidToken errors as a passphrase oracle.

Output format (stored in `secrets_vault`):
  kdf            "pbkdf2-sha256"
  salt_b64       16-byte random salt, urlsafe-b64
  iterations     PBKDF2 iteration count (default 480_000 — OWASP 2023+)
  ciphertext_b64 Fernet token of the actual plaintext
  verifier_b64   Fernet token of a fixed magic value ("elp-vault-v1")
"""
from __future__ import annotations

import base64
import os
from dataclasses import dataclass

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
    """Wrap `plaintext` with a key derived from `passphrase`.

    Generates a fresh salt every call so re-saving the same secret rotates
    the on-disk ciphertext. Both the secret and a fixed verifier value are
    encrypted under the same key; the verifier is what we check when the
    user later tries to unlock.
    """
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
    """Verify passphrase, then return plaintext.

    Raises `WrongPassphrase` if the verifier blob doesn't decrypt cleanly,
    so callers can distinguish a bad passphrase from genuine corruption
    of the ciphertext.
    """
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
