"""Accounts, sessions and usage entitlements for Ada.

Storage: SQLite (stdlib sqlite3, WAL). Location configurable via ADA_DB env.
Passwords: PBKDF2-HMAC-SHA256 (200k iters) with per-user salt — stdlib only.
Sessions: opaque 32-byte tokens in HttpOnly SameSite=Lax cookies.
Plans: free (monthly AI generation cap) / pro (unlimited, payment wiring
deferred — activation endpoint is clearly named and logged).
Guests remain usable without accounts (frontend local counter still applies);
server-side accounting only starts when a user is authenticated.
"""
from __future__ import annotations

import hashlib
import os
import secrets
import sqlite3
import threading
import time
from contextlib import contextmanager
from typing import Optional

_WRITE_LOCK = threading.Lock()

DB_PATH = os.path.abspath(
    os.environ.get("ADA_DB", os.path.join(os.path.dirname(__file__), "..", "data", "ada.db"))
)
FREE_MONTHLY_LIMIT = 10
SESSION_TTL_SECONDS = 30 * 24 * 3600
COOKIE_NAME = "ada_session"
PBKDF2_ITERATIONS = 200_000


def _connect() -> sqlite3.Connection:
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=5)
    conn.row_factory = sqlite3.Row
    return conn


@contextmanager
def _db():
    conn = _connect()
    try:
        conn.execute("PRAGMA journal_mode=WAL")
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db() -> None:
    with _WRITE_LOCK, _db() as db:
        db.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                email TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                salt BLOB NOT NULL,
                plan TEXT NOT NULL DEFAULT 'free',
                created_at REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sessions (
                token TEXT PRIMARY KEY,
                user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                expires_at REAL NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
            CREATE TABLE IF NOT EXISTS usage_ledger (
                user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                period TEXT NOT NULL,
                used INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (user_id, period)
            );
            """
        )


def _hash_password(password: str, salt: bytes) -> str:
    return hashlib.pbkdf2_hmac("sha256", password.encode(), salt, PBKDF2_ITERATIONS).hex()


def _period_key(ts: Optional[float] = None) -> str:
    # monthly bucket in UTC, e.g. "2026-10"
    return time.strftime("%Y-%m", time.gmtime(ts if ts is not None else time.time()))


class AccountError(Exception):
    def __init__(self, status: int, detail: str):
        self.status = status
        self.detail = detail


def create_user(email: str, password: str) -> Optional[sqlite3.Row]:
    email = email.strip().lower()
    if not email or "@" not in email or len(email) > 254:
        raise AccountError(422, "Enter a valid email address")
    if len(password) < 8:
        raise AccountError(422, "Password must be at least 8 characters")
    with _WRITE_LOCK, _db() as db:
        if db.execute("SELECT 1 FROM users WHERE email = ?", (email,)).fetchone():
            raise AccountError(409, "An account with this email already exists")
        user_id = secrets.token_hex(8)
        salt = secrets.token_bytes(16)
        db.execute(
            "INSERT INTO users (id, email, password_hash, salt, plan, created_at) VALUES (?, ?, ?, ?, 'free', ?)",
            (user_id, email, _hash_password(password, salt), salt, time.time()),
        )
    return _user_by_email(email)


def _user_by_email(email: str) -> Optional[sqlite3.Row]:
    with _db() as db:
        return db.execute("SELECT * FROM users WHERE email = ?", (email.strip().lower(),)).fetchone()


def _user_by_id(user_id: str) -> Optional[sqlite3.Row]:
    with _db() as db:
        return db.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()


def verify_login(email: str, password: str) -> sqlite3.Row:
    user = _user_by_email(email)
    if not user:
        raise AccountError(401, "Invalid email or password")
    expected = bytes.fromhex(user["password_hash"])
    actual = hashlib.pbkdf2_hmac("sha256", password.encode(), user["salt"], PBKDF2_ITERATIONS)
    if not secrets.compare_digest(expected, actual):
        raise AccountError(401, "Invalid email or password")
    return user


def create_session(user_id: str) -> str:
    token = secrets.token_urlsafe(32)
    with _WRITE_LOCK, _db() as db:
        db.execute(
            "INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)",
            (token, user_id, time.time() + SESSION_TTL_SECONDS),
        )
        db.execute("DELETE FROM sessions WHERE expires_at < ?", (time.time(),))
    return token


def delete_session(token: str) -> None:
    with _WRITE_LOCK, _db() as db:
        db.execute("DELETE FROM sessions WHERE token = ?", (token,))


def user_for_token(token: Optional[str]) -> Optional[sqlite3.Row]:
    if not token or len(token) < 20 or len(token) > 128:
        return None
    with _db() as db:
        row = db.execute(
            "SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ?",
            (token, time.time()),
        ).fetchone()
    return row


def set_plan(user_id: str, plan: str) -> None:
    if plan not in ("free", "pro"):
        raise AccountError(422, "Unknown plan")
    with _WRITE_LOCK, _db() as db:
        db.execute("UPDATE users SET plan = ? WHERE id = ?", (plan, user_id))


def usage_snapshot(user_id: str, plan: str) -> dict:
    period = _period_key()
    with _db() as db:
        row = db.execute(
            "SELECT used FROM usage_ledger WHERE user_id = ? AND period = ?", (user_id, period)
        ).fetchone()
    used = row["used"] if row else 0
    return {
        "period": period,
        "used": used,
        "limit": None if plan == "pro" else FREE_MONTHLY_LIMIT,
        "plan": plan,
    }


def check_generation_available(user_id: str, plan: str) -> None:
    """Fail before provider work when a free account has exhausted its cap."""
    if plan == "pro":
        return
    period = _period_key()
    with _db() as db:
        row = db.execute(
            "SELECT used FROM usage_ledger WHERE user_id = ? AND period = ?", (user_id, period)
        ).fetchone()
    used = row["used"] if row else 0
    if used >= FREE_MONTHLY_LIMIT:
        raise AccountError(
            429,
            f"Free plan monthly limit ({FREE_MONTHLY_LIMIT} generations) reached. Upgrade to Pro for unlimited generations.",
        )


def record_generation(user_id: str, plan: str) -> None:
    """Commit one successful online generation to the account ledger."""
    period = _period_key()
    with _WRITE_LOCK, _db() as db:
        if plan != "pro":
            row = db.execute(
                "SELECT used FROM usage_ledger WHERE user_id = ? AND period = ?", (user_id, period)
            ).fetchone()
            used = row["used"] if row else 0
            if used >= FREE_MONTHLY_LIMIT:
                raise AccountError(
                    429,
                    f"Free plan monthly limit ({FREE_MONTHLY_LIMIT} generations) reached. Upgrade to Pro for unlimited generations.",
                )
            db.execute(
                "INSERT INTO usage_ledger (user_id, period, used) VALUES (?, ?, 1) "
                "ON CONFLICT(user_id, period) DO UPDATE SET used = used + 1",
                (user_id, period),
            )
        else:
            db.execute(
                "INSERT INTO usage_ledger (user_id, period, used) VALUES (?, ?, 1) "
                "ON CONFLICT(user_id, period) DO UPDATE SET used = used + 1",
                (user_id, period),
            )