"""Metrics routes: event ingest + live summary + health."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel, Field

from ..db.events import ping, record_event, summarize

router = APIRouter()


class EventIn(BaseModel):
    user_id: str = Field(..., description="stable per-machine id, e.g. vscode.env.machineId")
    kind: str
    meta: dict[str, Any] = Field(default_factory=dict)


@router.post("/event")
async def post_event(ev: EventIn) -> dict[str, Any]:
    """Record a single event and return the fresh summary so the caller
    can update UI without polling."""
    await record_event(ev.user_id, ev.kind, ev.meta)
    return {"ok": True, "summary": await summarize(ev.user_id)}


@router.get("/summary")
async def get_summary(user_id: str) -> dict[str, Any]:
    """Fetch the current summary for a user. Used on extension startup
    to hydrate the status bar from any pre-existing events."""
    return await summarize(user_id)


@router.get("/health")
async def get_health() -> dict[str, Any]:
    """Explicit mongo reachability check. Use this to verify your
    MONGODB_URI in packages/api/.env resolves to a live cluster."""
    ok, detail = await ping()
    return {"ok": ok, "detail": detail}
