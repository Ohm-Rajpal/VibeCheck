"""Pydantic models — mirror of shared/types.ts."""
from typing import List, Optional, Literal
from pydantic import BaseModel, Field


class GeneratedQuestion(BaseModel):
    question: str
    concept_tag: str
    code_context: str
    file: str


class ComprehensionScore(BaseModel):
    what_it_does: float
    why_this_approach: float
    tradeoffs: float
    overall: float
    passed: bool
    feedback: str
    concepts_weak: List[str] = Field(default_factory=list)
    concepts_strong: List[str] = Field(default_factory=list)


CheckpointTrigger = Literal["velocity", "pre_commit", "devin_pr"]


class Checkpoint(BaseModel):
    checkpoint_id: str
    trigger: CheckpointTrigger
    triggered_at: str
    file: str
    diff_excerpt: str
    question: GeneratedQuestion
    transcript: Optional[str] = None
    score: Optional[ComprehensionScore] = None
    skipped: bool = False
    override_used: bool = False


class Session(BaseModel):
    session_id: str
    user_id: str
    repo: str
    branch: str
    started_at: str
    checkpoints: List[Checkpoint] = Field(default_factory=list)
    commit_sha: Optional[str] = None
    devin_pr_url: Optional[str] = None
