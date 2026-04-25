"""Gate routes — Layer 1 + 2A endpoints."""
from fastapi import APIRouter
from pydantic import BaseModel
from typing import List, Optional

router = APIRouter()


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
