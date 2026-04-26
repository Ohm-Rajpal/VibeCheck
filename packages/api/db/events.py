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

    generated = counts.get("ai_generated", 0)
    passed = counts.get("answer_passed", 0)
    overridden = counts.get("checkpoint_overridden", 0)
    dismissed = counts.get("checkpoint_dismissed", 0)
    submitted = counts.get("answer_submitted", 0)

    # Engagement = answered (passed) OR consciously overrode.
    # Dismissed / skipped don't count as engagement.
    reviewed = passed + overridden

    # Vibing = generations that slipped through without engagement.
    vibing = max(generated - reviewed, 0)

    denom = max(generated, 1)
    vibing_pct = round(100 * vibing / denom)
    learning_pct = (100 - vibing_pct) if generated else 0

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
    }
