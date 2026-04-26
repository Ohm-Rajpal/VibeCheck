"""Event telemetry for VibeCheck.

Every user action that matters for the "vibing vs learning" gauge is
recorded as an append-only document in the `events` collection. The
summary pipeline aggregates in Mongo so we never pull full event
history to the client.

Failure visibility:
  - On the FIRST failed insert (or first failed aggregate), we print a
    big banner to stderr so the dev sees "Mongo is not reachable" in
    the uvicorn log immediately — NOT silent zeros.
  - Subsequent failures log at WARNING level.
  - The editor flow never breaks — all network calls from the extension
    treat metrics as fire-and-forget, so a Mongo outage only zeros the
    gauge, it doesn't hang Submit/Override.
"""
from __future__ import annotations

import logging
import sys
from datetime import datetime, timezone
from typing import Any

from .mongo import MONGO_URI, db

logger = logging.getLogger(__name__)

EVENTS = db["events"]
# `sessions` is an immutable history of "what the gauges looked like
# right before the user reset". Each Reset Metrics click appends one
# document here so the Growth dashboard can render a trend over time
# (vibing → learning + cooking should drift over weeks of practice).
SESSIONS = db["sessions"]
# Lightweight "we've seen this user_id" registry. One doc per user_id,
# upserted whenever they hit /metrics/summary. Lets the demo seed
# script auto-detect a real user_id even when EVENTS and SESSIONS are
# both empty (e.g. immediately after a Reset).
USERS = db["users"]

# Allow-list of event kinds. Typos in the extension are dropped so they
# don't poison the aggregates.
EVENT_KINDS = {
    "ai_generated",
    "checkpoint_opened",
    "answer_submitted",
    "answer_passed",
    "checkpoint_overridden",
    "checkpoint_dismissed",
}

# Print the banner exactly once per process so the uvicorn log doesn't
# turn into a wall of identical errors on every event.
_loud_banner_shown = False


def _redact_uri(uri: str) -> str:
    """Strip credentials out of the connection string before logging."""
    if "@" in uri:
        return "mongodb+srv://***@" + uri.split("@", 1)[1]
    return uri


def _warn_once(op: str, kind: str, exc: Exception) -> None:
    global _loud_banner_shown
    detail = f"{type(exc).__name__}: {exc}"
    if not _loud_banner_shown:
        banner = "=" * 72
        print(
            "\n"
            + banner
            + "\n"
            + f"[VibeCheck metrics]  MongoDB {op} FAILED on kind={kind!r}\n"
            + f"  connection target : {_redact_uri(MONGO_URI)}\n"
            + f"  error             : {detail}\n"
            + "  \n"
            + "  → The vibing/learning gauge will stay at zero.\n"
            + "  → Fix: set MONGODB_URI in packages/api/.env to a reachable\n"
            + "    cluster (Atlas SRV string or a local mongod), then restart.\n"
            + banner
            + "\n",
            file=sys.stderr,
            flush=True,
        )
        _loud_banner_shown = True
    else:
        logger.warning("mongo %s failed kind=%s err=%s", op, kind, detail)


async def ping() -> tuple[bool, str]:
    """Lightweight health check. Returns (ok, detail)."""
    try:
        # `admin.command('ping')` is the canonical Mongo no-op health check.
        await db.client.admin.command("ping")
        # Also fetch a count so we confirm the `events` collection exists.
        doc_count = await EVENTS.estimated_document_count()
        return True, f"connected ({doc_count} events in collection)"
    except Exception as exc:  # noqa: BLE001
        return False, f"{type(exc).__name__}: {exc}"


async def reset_user(user_id: str) -> dict[str, Any]:
    """Atomically snapshot + delete the user's event history.

    Two-step semantics:
      1. Compute the current summary and append it as one document to
         the `sessions` collection (only if there's anything to snapshot
         — we don't want a wall of all-zero rows in the history when
         the user resets twice in a row).
      2. Delete every event for this user from `events`.

    Returns ``{"deleted": int, "snapshotted": bool}`` so the editor can
    show the user "snapshot saved + N events deleted" in one toast.
    On Mongo failure, ``deleted`` is -1.
    """
    if not user_id:
        logger.warning("reset_user: missing user_id, refusing to delete")
        return {"deleted": 0, "snapshotted": False}

    snapshotted = False
    try:
        snapshot = await summarize(user_id)
        # Only persist a snapshot if the user actually did something
        # this session — otherwise the trend chart fills with junk
        # rows when you double-tap Reset.
        if snapshot.get("generated", 0) > 0:
            doc = {
                "user_id": user_id,
                "ended_at": datetime.now(timezone.utc),
                # Persist BOTH percentages and raw counts so the chart
                # can re-render in different modes later (stacked bar,
                # absolute count, etc.) without re-deriving anything.
                "vibing_pct": snapshot.get("vibing_pct", 0),
                "learning_pct": snapshot.get("learning_pct", 0),
                "cooking_pct": snapshot.get("cooking_pct", 0),
                "generated": snapshot.get("generated", 0),
                "vibing_count": snapshot.get("vibing_count", 0),
                "passed": snapshot.get("passed", 0),
                "overridden": snapshot.get("overridden", 0),
                "dismissed": snapshot.get("dismissed", 0),
            }
            await SESSIONS.insert_one(doc)
            snapshotted = True
    except Exception as exc:  # noqa: BLE001
        # Snapshot failure is non-fatal — we still proceed with the
        # delete so the user's reset intent is honored.
        _warn_once("snapshot", "reset", exc)

    try:
        result = await EVENTS.delete_many({"user_id": user_id})
        return {"deleted": int(result.deleted_count), "snapshotted": snapshotted}
    except Exception as exc:  # noqa: BLE001
        _warn_once("delete_many", "reset", exc)
        return {"deleted": -1, "snapshotted": snapshotted}


async def list_sessions(user_id: str, limit: int = 30) -> list[dict[str, Any]]:
    """Return up to `limit` past session snapshots, oldest → newest.

    The Growth dashboard renders these as a stacked bar chart so the
    user can see vibing% shrinking and learning/cooking growing over
    time. Empty list on any Mongo error (fail-soft, same as summarize).
    """
    if not user_id:
        return []
    try:
        cursor = (
            SESSIONS.find({"user_id": user_id})
            .sort("ended_at", -1)
            .limit(max(1, min(limit, 200)))
        )
        rows: list[dict[str, Any]] = []
        async for doc in cursor:
            rows.append(
                {
                    "ended_at": doc.get("ended_at").isoformat()
                    if doc.get("ended_at")
                    else None,
                    "vibing_pct": int(doc.get("vibing_pct", 0)),
                    "learning_pct": int(doc.get("learning_pct", 0)),
                    "cooking_pct": int(doc.get("cooking_pct", 0)),
                    "generated": int(doc.get("generated", 0)),
                    "passed": int(doc.get("passed", 0)),
                    "overridden": int(doc.get("overridden", 0)),
                    "vibing_count": int(doc.get("vibing_count", 0)),
                    "dismissed": int(doc.get("dismissed", 0)),
                }
            )
        # Reverse so the chart renders oldest-on-the-left, newest-on-
        # the-right (the natural reading order for a time series).
        rows.reverse()
        return rows
    except Exception as exc:  # noqa: BLE001
        _warn_once("list_sessions", "history", exc)
        return []


async def record_event(
    user_id: str,
    kind: str,
    meta: dict[str, Any] | None = None,
) -> None:
    if not user_id:
        logger.warning("record_event: missing user_id, dropping")
        return
    if kind not in EVENT_KINDS:
        logger.warning("record_event: unknown kind=%s, dropping", kind)
        return
    doc = {
        "user_id": user_id,
        "kind": kind,
        "meta": meta or {},
        "ts": datetime.now(timezone.utc),
    }
    try:
        await EVENTS.insert_one(doc)
    except Exception as exc:  # noqa: BLE001
        _warn_once("insert", kind, exc)


async def summarize(user_id: str) -> dict[str, Any]:
    """Compute the live vibing/learning summary for a user.

    Safe zeros on mongo failure so the status bar never flickers into
    an error state.
    """
    counts: dict[str, int] = {}
    first_try_passes = 0
    # Fire-and-forget user_id registration so the seed script's --auto
    # mode can find the user even when they have zero events recorded.
    if user_id:
        try:
            await USERS.update_one(
                {"_id": user_id},
                {"$set": {"last_seen": datetime.now(timezone.utc)}},
                upsert=True,
            )
        except Exception:  # noqa: BLE001
            # Don't let user-tracking cripple the actual summary call —
            # the dashboard must keep working if this fails.
            pass
    try:
        pipeline = [
            {"$match": {"user_id": user_id}},
            {"$group": {"_id": "$kind", "count": {"$sum": 1}}},
        ]
        async for entry in EVENTS.aggregate(pipeline):
            counts[entry["_id"]] = entry["count"]

        async for entry in EVENTS.aggregate(
            [
                {
                    "$match": {
                        "user_id": user_id,
                        "kind": "answer_passed",
                        "meta.attempt": 1,
                    }
                },
                {"$count": "n"},
            ]
        ):
            first_try_passes = entry.get("n", 0)
    except Exception as exc:  # noqa: BLE001
        _warn_once("aggregate", "summary", exc)

    passed = counts.get("answer_passed", 0)
    overridden = counts.get("checkpoint_overridden", 0)
    dismissed = counts.get("checkpoint_dismissed", 0)
    submitted = counts.get("answer_submitted", 0)

    # Engagement = answered (passed) OR consciously overrode.
    # Dismissed / skipped don't count as engagement.
    reviewed = passed + overridden
    generated = max(counts.get("ai_generated", 0), reviewed + dismissed)

    # Vibing = generations that slipped through without engagement.
    vibing = max(generated - reviewed, 0)

    # Three-way split that mirrors the frontend's `normalizeSummary` so
    # snapshots saved server-side show identical numbers to the live
    # gauges. learning_pct + cooking_pct + vibing_pct == 100, with the
    # remainder absorbed by vibing_pct so rounding never produces 99/101.
    if generated:
        learning_pct = round(100 * passed / generated)
        cooking_pct = round(100 * overridden / generated) if overridden else 0
        vibing_pct = max(0, 100 - learning_pct - cooking_pct)
    else:
        learning_pct = 0
        cooking_pct = 0
        vibing_pct = 0

    first_try_rate_pct = (
        round(100 * first_try_passes / generated) if generated else 0
    )

    return {
        "generated": generated,
        "reviewed": reviewed,
        "submitted": submitted,
        "passed": passed,
        "passed_first_try": first_try_passes,
        "first_try_rate_pct": first_try_rate_pct,
        "overridden": overridden,
        "dismissed": dismissed,
        "vibing_count": vibing,
        "vibing_pct": vibing_pct,
        "learning_pct": learning_pct,
        "cooking_pct": cooking_pct,
    }
