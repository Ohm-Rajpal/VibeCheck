"""VibeCheck FastAPI backend entrypoint."""
import sys
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

# Load env BEFORE importing the routes. Services like gemini.py read
# os.getenv at import time, so this MUST run first. We try both common
# locations: the repo root (one parent above `packages/`) and
# `packages/api/.env`, in that order. Earlier-loaded keys win, but we
# also try the api-package one with override=False so root is the
# primary source of truth.
_API_PKG = Path(__file__).resolve().parent
_REPO_ROOT = _API_PKG.parent.parent
load_dotenv(_REPO_ROOT / ".env", override=False)
load_dotenv(_API_PKG / ".env", override=False)
# Plus the legacy CWD-walking behaviour as a safety net.
load_dotenv(override=False)

from .db.events import ping as mongo_ping  # noqa: E402
from .db.mongo import MONGO_URI  # noqa: E402
from .routes import gate, growth, metrics, webhook  # noqa: E402

app = FastAPI(title="VibeCheck API", version="0.0.1")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(gate.router, prefix="/gate", tags=["gate"])
app.include_router(growth.router, prefix="/growth", tags=["growth"])
app.include_router(metrics.router, prefix="/metrics", tags=["metrics"])
app.include_router(webhook.router, prefix="/webhook", tags=["webhook"])


@app.on_event("startup")
async def _mongo_startup_ping() -> None:
    """Ping Mongo on boot and print a loud banner so the dev immediately
    sees whether the vibing/learning gauge will work. Does NOT crash the
    server on failure — the rest of the API (gate/verify, etc.) stays
    usable even if metrics are offline."""
    ok, detail = await mongo_ping()
    redacted = MONGO_URI
    if "@" in redacted:
        redacted = "mongodb+srv://***@" + redacted.split("@", 1)[1]
    bar = "=" * 72
    if ok:
        print(
            f"\n{bar}\n"
            f"[VibeCheck metrics]  MongoDB connected ✓\n"
            f"  target : {redacted}\n"
            f"  status : {detail}\n"
            f"{bar}\n",
            flush=True,
        )
    else:
        print(
            f"\n{bar}\n"
            f"[VibeCheck metrics]  MongoDB UNREACHABLE ✗\n"
            f"  target : {redacted}\n"
            f"  error  : {detail}\n"
            f"  \n"
            f"  The vibing/learning gauge will stay at zero until this is fixed.\n"
            f"  Set MONGODB_URI in packages/api/.env to a reachable cluster\n"
            f"  (Atlas SRV string) and restart uvicorn.\n"
            f"{bar}\n",
            file=sys.stderr,
            flush=True,
        )


@app.get("/health")
async def health():
    return {"ok": True}
