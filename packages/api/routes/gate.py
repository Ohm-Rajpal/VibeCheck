"""Gate routes - comprehension checkpoint endpoints."""
from fastapi import APIRouter, File, Response, UploadFile

from ..schemas.gate import (
    GeneratedQuestion,
    QuestionRequest,
    SpeakRequest,
    TranscribeResponse,
    VerifyRequest,
    VerifyResponse,
)
from ..services.checkpoints import (
    evaluate_transcript,
    generate_question,
    lookup_question,
)
from ..services.elevenlabs import synthesize_speech, transcribe_audio

router = APIRouter()


@router.post("/question", response_model=GeneratedQuestion)
async def question(req: QuestionRequest) -> GeneratedQuestion:
    """Generate ONE design-choice comprehension question for a freshly-detected
    AI-authored code region. The returned `checkpoint_id` is what the client
    must echo back on `/gate/verify` so the server can grade against the same
    code+question pair.
    """
    return await generate_question(req)


@router.post("/verify", response_model=VerifyResponse)
async def verify(req: VerifyRequest) -> VerifyResponse:
    """Evaluate a transcribed spoken answer against one checkpoint question."""
    question = lookup_question(req)
    score = await evaluate_transcript(req.transcript, question)
    return VerifyResponse(checkpoint_id=req.checkpoint_id, score=score)


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
