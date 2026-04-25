"""GitHub webhook for Devin PR detection (Layer 2B)."""
from fastapi import APIRouter, Request

router = APIRouter()

DEVIN_BOT_LOGINS = ["devin-ai-integration[bot]"]


@router.post("/github")
async def github_webhook(request: Request):
    payload = await request.json()
    if payload.get("action") not in ("opened", "synchronize"):
        return {"status": "ignored"}

    sender = payload.get("sender", {}).get("login", "")
    if not any(bot in sender for bot in DEVIN_BOT_LOGINS):
        return {"status": "not_devin"}

    # TODO: fetch PR diff, generate questions, persist session,
    # notify VSCode extension via local server (:3456).
    return {"status": "checkpoint_triggered"}
