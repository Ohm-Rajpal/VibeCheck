"""MongoDB connection (Motor async client)."""
import os
from motor.motor_asyncio import AsyncIOMotorClient

MONGO_URI = os.getenv("MONGODB_URI", "mongodb://localhost:27017")
DB_NAME = os.getenv("MONGODB_DB", "vibecheck")

_client: AsyncIOMotorClient | None = None


def get_client() -> AsyncIOMotorClient:
    global _client
    if _client is None:
        _client = AsyncIOMotorClient(MONGO_URI)
    return _client


def get_db():
    return get_client()[DB_NAME]


# Convenience handle.
db = get_db()
