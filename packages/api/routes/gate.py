"""Gate routes - comprehension checkpoint endpoints."""
import os
from fastapi import APIRouter, File, Response, UploadFile

from ..schemas.gate import (
    GenerateQuestionsRequest,
    GenerateQuestionsResponse,
    SpeakRequest,
    TranscribeResponse,
    VerifyRequest,
    VerifyResponse,
)
from ..services.checkpoints import (
    evaluate_transcript,
    generate_questions_with_llm,
    lookup_question,
)
from ..services.elevenlabs import synthesize_speech, transcribe_audio

router = APIRouter()
DEBUG_FLOW = os.getenv("VIBECHECK_DEBUG_FLOW", "0") == "1"


@router.post("/verify", response_model=VerifyResponse)
async def verify(req: VerifyRequest) -> VerifyResponse:
    """Evaluate a transcribed spoken answer against one checkpoint question."""
    question = lookup_question(req)
    score = await evaluate_transcript(req.transcript, question)
    return VerifyResponse(checkpoint_id=req.checkpoint_id, score=score)


@router.post("/generate-questions", response_model=GenerateQuestionsResponse)
async def generate_questions(req: GenerateQuestionsRequest) -> GenerateQuestionsResponse:
    """Generate checkpoint questions from diff + function context."""
    if DEBUG_FLOW:
        print(
            "[VibeCheck] /gate/generate-questions request: "
            f"workspaceRoot={req.workspaceRoot or '<unset>'} "
            f"stagedDiffChars={len(req.stagedDiff or '')} "
            f"localQuestions={len(req.localQuestions or [])}"
        )
    questions = await generate_questions_with_llm(req.stagedDiff, req.localQuestions)
    if DEBUG_FLOW:
        first = questions[0] if questions else {}
        print(
            "[VibeCheck] /gate/generate-questions response: "
            f"questions={len(questions)} "
            f"first.question={str(first.get('question', ''))[:120]!r}"
        )
    return GenerateQuestionsResponse(questions=questions)


@router.post("/transcribe", response_model=TranscribeResponse)
async def transcribe_answer(audio: UploadFile = File(...)) -> TranscribeResponse:
    """Transcribe a spoken quiz answer with ElevenLabs Speech to Text."""
    payload = await transcribe_audio(audio)
    return TranscribeResponse(
        text=payload.get("text", ""),
        language_code=payload.get("language_code"),
        language_probability=payload.get("language_probability"),
    )


@router.post("/speak")
async def speak_feedback(req: SpeakRequest) -> Response:
    """Generate playable feedback audio from evaluator text."""
    return await synthesize_speech(req.text, req.voice_id)


@router.post("/agent-commit")
async def agent_commit(payload: dict):
    # TODO: log agent-driven commit for manager visibility.
    return {"logged": True}


@router.post("/timeout")
async def timeout(payload: dict):
    # TODO: mark session as skipped.
    return {"ok": True}
