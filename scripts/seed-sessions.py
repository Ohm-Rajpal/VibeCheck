#!/usr/bin/env python3
"""Seed the `sessions` collection with a compressed dramatic story arc.

Run before a demo so the Growth dashboard renders an existing trend
the moment the user opens it. The first live Reset they perform during
the demo will visibly extend that trend with one more bar — much more
impressive than starting from a blank chart.

Story arc: 8 sessions over ~7 days. Starts heavy vibing (~80%) and
finishes with cooking + learning dominating. Per-step changes are
intentionally large so the gradient is obvious in a 30-second demo.

Usage:
    python scripts/seed-sessions.py --user-id <vscode_machine_id>
    python scripts/seed-sessions.py --user-id <id> --replace      # wipe & reseed
    python scripts/seed-sessions.py --auto                        # auto-detect from recent events
    python scripts/seed-sessions.py --auto --replace

The user_id MUST match `vscode.env.machineId` from the editor that
will be used in the demo. Easiest way to get it:

  1. Run the API:        npm run start:api
  2. Reload the editor:  Ctrl+Shift+P → Developer: Reload Window
  3. The extension fires GET /metrics/summary?user_id=<your_id>...
     and uvicorn logs that line, e.g.:

        INFO:  GET /metrics/summary?user_id=3c570d83d15aad... 200 OK

  4. Pass that user_id to this script.

OR pass `--auto` and we'll grab the user_id from the most recent
event in the database (works as long as the extension has hit the
API even once since the last DB wipe).
"""
from __future__ import annotations

import argparse
import asyncio
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

# Make the package importable when running this file directly.
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

# Load MONGODB_URI BEFORE importing the db module — `db.mongo` reads
# os.getenv at import time, so without this the script would silently
# fall back to localhost:27017 and fail with a connection-refused
# error against a Mongo that isn't running locally. We try both common
# locations: repo root and packages/api/, matching what main.py does.
from dotenv import load_dotenv  # noqa: E402

load_dotenv(ROOT / ".env", override=False)
load_dotenv(ROOT / "packages" / "api" / ".env", override=False)

from packages.api.db.events import EVENTS, SESSIONS, USERS  # noqa: E402


# Each entry is (vibing_pct, learning_pct, cooking_pct, generated).
# generated is the rough volume of AI regions that session — used to
# back-fill the raw counts so tooltips are believable, not just the
# percentages. Numbers chosen to feel like a real intern ramping up:
# huge volume of unread AI early, more deliberate engagement later.
ARC: list[tuple[int, int, int, int]] = [
    # day 0: peak vibing — accepts everything blindly
    (82, 8,  10, 24),
    # day 1: starts paying attention
    (68, 18, 14, 22),
    # day 2: first big checkpoint pass spike
    (54, 30, 16, 28),
    # day 3: tries an override, likes it
    (45, 32, 23, 26),
    # day 4: regression — got busy, vibed through some
    (51, 28, 21, 30),
    # day 5: bounces back hard
    (32, 42, 26, 25),
    # day 6: best learning yet
    (24, 48, 28, 27),
    # day 7 (yesterday): cooking domination
    (18, 47, 35, 23),
]


def synthesize(
    user_id: str,
    ended_at: datetime,
    vibing_pct: int,
    learning_pct: int,
    cooking_pct: int,
    generated: int,
) -> dict:
    """Build a session document matching the schema written by
    `reset_user` so the dashboard reads seeded rows identically to
    organic ones."""
    # Derive raw counts from the percentages so the tooltip "X of Y"
    # text reads as plausible. Uses round() — this can drift +/-1 from
    # the percentage * generated product, which is fine; the chart
    # uses the percentage directly anyway.
    passed     = round(generated * learning_pct / 100)
    overridden = round(generated * cooking_pct  / 100)
    vibing_ct  = max(0, generated - passed - overridden)
    return {
        "user_id": user_id,
        "ended_at": ended_at,
        "vibing_pct": vibing_pct,
        "learning_pct": learning_pct,
        "cooking_pct": cooking_pct,
        "generated": generated,
        "vibing_count": vibing_ct,
        "passed": passed,
        "overridden": overridden,
        # Dismissed isn't part of the visible chart; pad it with the
        # vibing remainder so the schema looks complete.
        "dismissed": vibing_ct,
    }


async def seed(user_id: str, replace: bool) -> None:
    if replace:
        deleted = await SESSIONS.delete_many({"user_id": user_id})
        print(f"[seed] removed {deleted.deleted_count} existing sessions")

    # Anchor the most recent seeded session ~12 hours ago so the live
    # Reset the user performs during the demo lands a visibly fresh
    # bar at the right edge of the chart.
    now = datetime.now(timezone.utc)
    end_anchor = now - timedelta(hours=12)
    docs = []
    for i, (v, l, c, g) in enumerate(ARC):
        # Walk backwards from the anchor in 1-day steps, oldest first.
        ended_at = end_anchor - timedelta(days=(len(ARC) - 1 - i))
        docs.append(synthesize(user_id, ended_at, v, l, c, g))

    # `insert_many` is fine for ~10 docs — no need to batch.
    result = await SESSIONS.insert_many(docs)
    print(f"[seed] inserted {len(result.inserted_ids)} sessions for user_id={user_id!r}")
    print(
        "[seed] arc preview (oldest → newest, vibing/learning/cooking):"
    )
    for v, l, c, _ in ARC:
        bar = "🔴" * (v // 8) + "🟢" * (l // 8) + "🔵" * (c // 8)
        print(f"  {v:3d}/{l:3d}/{c:3d}  {bar}")


async def detect_user_id() -> str | None:
    """Pick the most recently seen user_id from any collection.

    Search order, most→least informative:
      1. USERS  — upserted on every /metrics/summary fetch, so this
                  works the instant the dashboard renders, even if
                  events + sessions are both empty.
      2. EVENTS — the user has fired at least one VibeCheck event.
      3. SESSIONS — the user has reset at least once.

    Returns None if NO collection has a user_id, in which case the
    extension hasn't talked to this MongoDB yet — the user must reload
    Windsurf with the API running, then retry.
    """
    # 1. USERS keyed by user_id (we use _id to enforce uniqueness).
    cursor = USERS.find({}, {"_id": 1}).sort("last_seen", -1).limit(1)
    async for doc in cursor:
        if doc.get("_id"):
            return doc["_id"]
    # 2. EVENTS fallback.
    cursor = EVENTS.find({}, {"user_id": 1}).sort("_id", -1).limit(1)
    async for doc in cursor:
        if doc.get("user_id"):
            return doc["user_id"]
    # 3. SESSIONS fallback.
    cursor = SESSIONS.find({}, {"user_id": 1}).sort("_id", -1).limit(1)
    async for doc in cursor:
        if doc.get("user_id"):
            return doc["user_id"]
    return None


async def run(user_id: str | None, auto: bool, replace: bool) -> None:
    if auto:
        detected = await detect_user_id()
        if not detected:
            print(
                "[seed] --auto failed: no user_id found in events or "
                "sessions. Run the extension once (Reload Window) so it "
                "hits /metrics/summary, then re-run this script.",
                file=sys.stderr,
            )
            sys.exit(2)
        print(f"[seed] auto-detected user_id={detected!r}")
        user_id = detected
    elif not user_id:
        print(
            "[seed] --user-id is required (or pass --auto).",
            file=sys.stderr,
        )
        sys.exit(2)

    await seed(user_id, replace)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument(
        "--user-id",
        help="vscode.env.machineId from the editor you're demoing in. "
        "Pass --auto to grab the most recent one from the DB instead.",
    )
    parser.add_argument(
        "--replace",
        action="store_true",
        help="Delete this user's existing seeded sessions before inserting.",
    )
    parser.add_argument(
        "--auto",
        action="store_true",
        help="Auto-detect user_id from the most recent event/session.",
    )
    args = parser.parse_args()
    asyncio.run(run(args.user_id, args.auto, args.replace))


if __name__ == "__main__":
    main()
