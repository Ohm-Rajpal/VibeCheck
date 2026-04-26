"""Schemas for comprehension checkpoint routes."""
from typing import List, Optional

from pydantic import BaseModel, ConfigDict, Field

from ..services.elevenlabs import ELEVENLABS_STT_MODEL_ID


class GeneratedQuestion(BaseModel):
    checkpoint_id: str
    question: str
    concept_tag: str
    code_context: str
    file: str
    diff_excerpt: str


class QuestionRequest(BaseModel):
    """Asks the model to generate ONE design-choice question for a freshly-detected
    AI-authored region. The extension sends the actual region text so the question
    can be hyper-specific to what was generated.
    """

    session_id: str = "mock-session"
    checkpoint_id: str = ""  # extension may pre-assign; otherwise server fills
    code: str
    file: str = "unknown"
    language: Optional[str] = None  # e.g., "typescript", "python"
    start_line: int = 0
    end_line: int = 0


class VerifyRequest(BaseModel):
    session_id: str = "mock-session"
    checkpoint_id: str = "mock-checkpoint"
    transcript: str
    question: Optional[str] = None
    diff_excerpt: Optional[str] = None
    file: Optional[str] = None


class ComprehensionScore(BaseModel):
    what_it_does: float
    why_this_approach: float
    tradeoffs: float
    overall: float
    passed: bool
    feedback: str
    follow_up_question: Optional[str] = None
    concepts_weak: List[str] = Field(default_factory=list)
    concepts_strong: List[str] = Field(default_factory=list)
    spoken_response: str


class VerifyResponse(BaseModel):
    checkpoint_id: str
    score: ComprehensionScore


class TranscribeResponse(BaseModel):
    model_config = ConfigDict(protected_namespaces=())

    text: str
    language_code: Optional[str] = None
    language_probability: Optional[float] = None
    model_id: str = Field(default=ELEVENLABS_STT_MODEL_ID)


class SpeakRequest(BaseModel):
    text: str
    voice_id: Optional[str] = None
