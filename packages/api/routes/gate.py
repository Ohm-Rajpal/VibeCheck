"""Gate routes — Layer 1 + 2A endpoints."""
import os

import httpx
from fastapi import APIRouter, File, HTTPException, UploadFile
from pydantic import BaseModel, Field
from typing import List, Optional

router = APIRouter()

ELEVENLABS_STT_URL = "https://api.elevenlabs.io/v1/speech-to-text"
ELEVENLABS_MODEL_ID = os.getenv("ELEVENLABS_STT_MODEL", "scribe_v2")


class GenerateRequest(BaseModel):
    diff: str
    claude_md: str = ""
    user_email: str
    diff_lines: int
    mode: str  # 'inline' | 'commit' | 'devin_pr'
    skipped_sections: Optional[List[str]] = None


class GenerateResponse(BaseModel):
    session_id: str
    questions: List[dict]


class VerifyRequest(BaseModel):
    session_id: str
    checkpoint_id: str
    transcript: str


class TranscribeResponse(BaseModel):
    text: str
    language_code: Optional[str] = None
    language_probability: Optional[float] = None
    model_id: str = Field(default=ELEVENLABS_MODEL_ID)


@router.post("/generate", response_model=GenerateResponse)
async def generate(req: GenerateRequest) -> GenerateResponse:
    # TODO: call ai.question_gen.generate_questions, persist session in MongoDB.
    return GenerateResponse(session_id="stub-session", questions=[])


@router.post("/verify")
async def verify(req: VerifyRequest):
    # TODO: call ai.evaluator.evaluate, persist score, return ComprehensionScore.
    return {"score": None}


@router.post("/agent-commit")
async def agent_commit(payload: dict):
    # TODO: log agent-driven commit for manager visibility.
    return {"logged": True}


@router.post("/timeout")
async def timeout(payload: dict):
    # TODO: mark session as skipped.
    return {"ok": True}


@router.post("/transcribe", response_model=TranscribeResponse)
async def transcribe_answer(audio: UploadFile = File(...)) -> TranscribeResponse:
    """Transcribe a spoken quiz answer with ElevenLabs Speech to Text."""
    api_key = os.getenv("ELEVENLABS_API_KEY")
    if not api_key:
        raise HTTPException(
            status_code=500,
            detail="ELEVENLABS_API_KEY is not configured",
        )

    audio_bytes = await audio.read()
    if not audio_bytes:
        raise HTTPException(status_code=400, detail="Audio upload is empty")

    filename = audio.filename or "answer.webm"
    content_type = audio.content_type or "application/octet-stream"

    try:
        async with httpx.AsyncClient(timeout=60) as client:
            response = await client.post(
                ELEVENLABS_STT_URL,
                headers={"xi-api-key": api_key},
                data={"model_id": ELEVENLABS_MODEL_ID},
                files={"file": (filename, audio_bytes, content_type)},
            )
            response.raise_for_status()
    except httpx.HTTPStatusError as exc:
        raise HTTPException(
            status_code=exc.response.status_code,
            detail=f"ElevenLabs transcription failed: {exc.response.text}",
        ) from exc
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Could not reach ElevenLabs transcription service: {exc}",
        ) from exc

    payload = response.json()
    return TranscribeResponse(
        text=payload.get("text", ""),
        language_code=payload.get("language_code"),
        language_probability=payload.get("language_probability"),
    )
