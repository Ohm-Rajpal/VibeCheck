"""MongoDB connection (Motor async client).

Reads MONGODB_URI from the env; falls back to `mongodb://localhost:27017`
only when the var is unset or explicitly empty. We set a short
serverSelectionTimeoutMS so the fail-soft path completes in ~2s
instead of the 30s default, making misconfigurations obvious.
"""
import os

from motor.motor_asyncio import AsyncIOMotorClient

# An explicitly-empty env var is treated the same as unset — otherwise
# an empty `MONGODB_URI=` in .env would hand Motor an invalid URI.
MONGO_URI = os.getenv("MONGODB_URI") or "mongodb://localhost:27017"
DB_NAME = os.getenv("MONGODB_DB") or "vibecheck"

_client: AsyncIOMotorClient | None = None


def get_client() -> AsyncIOMotorClient:
    global _client
    if _client is None:
        _client = AsyncIOMotorClient(MONGO_URI, serverSelectionTimeoutMS=2000)
    return _client


def get_db():
    return get_client()[DB_NAME]


# Convenience handle.
db = get_db()
