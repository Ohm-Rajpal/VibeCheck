"""VibeCheck FastAPI backend entrypoint."""
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv

# Load variables from packages/api/.env when present.
API_ENV_PATH = Path(__file__).resolve().parent / ".env"
load_dotenv(dotenv_path=API_ENV_PATH)

from .routes import gate, growth, webhook

app = FastAPI(title="VibeCheck API", version="0.0.1")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(gate.router, prefix="/gate", tags=["gate"])
app.include_router(growth.router, prefix="/growth", tags=["growth"])
app.include_router(webhook.router, prefix="/webhook", tags=["webhook"])


@app.get("/health")
async def health():
    return {"ok": True}
