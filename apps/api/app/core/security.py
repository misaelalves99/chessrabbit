"""Password hashing and JWT issuance/verification."""

from __future__ import annotations

import hashlib
import secrets
from datetime import datetime, timedelta, timezone

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError, VerificationError, InvalidHashError

from app.core.config import settings

_ph = PasswordHasher()


# ---------- passwords ----------

def hash_password(password: str) -> str:
    return _ph.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    try:
        _ph.verify(password_hash, password)
        return True
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        return False


# ---------- opaque tokens (refresh / email) ----------

def generate_token() -> str:
    """Opaque random token handed to the user."""
    return secrets.token_urlsafe(48)


def hash_token(token: str) -> str:
    """Only hashes are stored, so a DB leak does not yield usable tokens."""
    return hashlib.sha256(token.encode()).hexdigest()


# ---------- JWT access tokens ----------

def create_access_token(user_id: int, plan: str) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "sub": str(user_id),
        "plan": plan,
        "iat": now,
        "exp": now + timedelta(minutes=settings.ACCESS_TOKEN_TTL_MIN),
        "type": "access",
        # Names this token so signing out can revoke exactly it rather than
        # every session the account has open. See core/revocation.py.
        "jti": secrets.token_urlsafe(16),
    }
    return jwt.encode(payload, settings.JWT_SECRET, algorithm=settings.JWT_ALGORITHM)


def decode_access_token(token: str) -> dict | None:
    try:
        payload = jwt.decode(token, settings.JWT_SECRET, algorithms=[settings.JWT_ALGORITHM])
    except jwt.PyJWTError:
        return None
    if payload.get("type") != "access":
        return None
    return payload


# ---------- admin tokens ----------
#
# A separate credential, not a claim on the player token. The dashboard shows
# every customer's email and can change what they pay, so it must not be
# reachable with the token the player-facing app keeps in localStorage - an XSS
# anywhere in that app would otherwise inherit admin.
#
# The isolation is the `type` field, checked in both directions: decode_access_token
# above rejects anything that is not "access", and decode_admin_token below
# rejects anything that is not "admin". Neither token can stand in for the other,
# and both are pinned by tests/test_admin.py.

def create_admin_token(user_id: int) -> str:
    """Short-lived token for the /admin surface. Deliberately not refreshable."""
    now = datetime.now(timezone.utc)
    payload = {
        "sub": str(user_id),
        "scope": "admin",
        "iat": now,
        "exp": now + timedelta(minutes=settings.ADMIN_TOKEN_TTL_MIN),
        "type": "admin",
        "jti": secrets.token_urlsafe(16),
    }
    return jwt.encode(payload, settings.JWT_SECRET, algorithm=settings.JWT_ALGORITHM)


def decode_admin_token(token: str) -> dict | None:
    try:
        payload = jwt.decode(token, settings.JWT_SECRET, algorithms=[settings.JWT_ALGORITHM])
    except jwt.PyJWTError:
        return None
    if payload.get("type") != "admin" or payload.get("scope") != "admin":
        return None
    return payload
