"""Metrics routes: event ingest + live summary + health."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel, Field

from ..db.events import (
    list_sessions,
    ping,
    record_event,
    reset_user,
    summarize,
)

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


@router.post("/reset")
async def post_reset(payload: dict[str, str]) -> dict[str, Any]:
    """Snapshot the user's current summary into the `sessions`
    collection, then delete every event from `events`. Triggered from
    the editor's `VibeCheck: Reset My Metrics` command (and the
    in-dashboard Reset button).

    POST body: `{"user_id": "<machineId>"}`. Returns the deleted count,
    whether a snapshot was saved (false when there was nothing to
    snapshot), and the now-empty summary so the caller can update the
    gauges without a follow-up GET.
    """
    user_id = (payload or {}).get("user_id", "")
    result = await reset_user(user_id)
    return {
        "ok": result["deleted"] >= 0,
        "deleted": result["deleted"],
        "snapshotted": result["snapshotted"],
        "summary": await summarize(user_id),
    }


@router.get("/sessions")
async def get_sessions(user_id: str, limit: int = 30) -> dict[str, Any]:
    """Return historical session snapshots for the user, ordered
    oldest → newest. Used by the Growth dashboard's stacked bar chart
    to show how the vibing/learning/cooking mix evolves over time.
    """
    return {"sessions": await list_sessions(user_id, limit=limit)}


@router.get("/health")
async def get_health() -> dict[str, Any]:
    """Explicit mongo reachability check. Use this to verify your
    MONGODB_URI in packages/api/.env resolves to a live cluster."""
    ok, detail = await ping()
    return {"ok": ok, "detail": detail}
