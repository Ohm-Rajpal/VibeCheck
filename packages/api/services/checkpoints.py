"""Checkpoint generation, lookup, and answer evaluation."""
import json
import re
from typing import List, Optional

from fastapi import HTTPException

from ..schemas.gate import ComprehensionScore, GeneratedQuestion, VerifyRequest
from .gemini import call_gemini_json

SESSION_STORE: dict[str, dict[str, GeneratedQuestion]] = {}


def save_session_questions(session_id: str, questions: List[GeneratedQuestion]) -> None:
    SESSION_STORE[session_id] = {q.checkpoint_id: q for q in questions}


async def evaluate_transcript(
    transcript: str, question: GeneratedQuestion
) -> ComprehensionScore:
    if not transcript.strip():
        raise HTTPException(status_code=400, detail="Transcript is required")

    llm_score = await evaluate_with_llm(transcript, question)
    if llm_score:
        return llm_score

    return evaluate_with_heuristics(transcript, question)


def lookup_question(req: VerifyRequest) -> GeneratedQuestion:
    stored_question = SESSION_STORE.get(req.session_id, {}).get(req.checkpoint_id)
    if stored_question:
        return stored_question

    if req.question and req.diff_excerpt:
        return GeneratedQuestion(
            checkpoint_id=req.checkpoint_id,
            question=req.question,
            concept_tag="code comprehension",
            code_context=req.file or "unknown",
            file=req.file or "unknown",
            diff_excerpt=req.diff_excerpt,
        )

    raise HTTPException(
        status_code=404,
        detail=(
            "Checkpoint not found. Pass a valid session_id/checkpoint_id, "
            "or include question and diff_excerpt in the verify request."
        ),
    )


async def evaluate_with_llm(
    transcript: str, question: GeneratedQuestion
) -> Optional[ComprehensionScore]:
    system = (
        "You are VibeCheck, a concise senior-engineer oral examiner. "
        "Evaluate whether the developer's spoken answer shows real understanding "
        "of the code diff. Return only valid JSON."
    )
    prompt = {
        "question": question.question,
        "file": question.file,
        "code_context": question.code_context,
        "diff_excerpt": question.diff_excerpt,
        "transcript": transcript,
        "rubric": {
            "what_it_does": "Does the answer correctly explain what changed?",
            "why_this_approach": "Does it explain why this implementation or approach makes sense?",
            "tradeoffs": "Does it mention risks, edge cases, or tradeoffs?",
            "passed": "True when overall >= 0.65 and no dimension is below 0.4.",
        },
        "required_json_shape": {
            "what_it_does": 0.0,
            "why_this_approach": 0.0,
            "tradeoffs": 0.0,
            "overall": 0.0,
            "passed": False,
            "feedback": "short text",
            "follow_up_question": "short text or null",
            "concepts_weak": ["string"],
            "concepts_strong": ["string"],
            "spoken_response": "one or two conversational sentences to say out loud",
        },
    }
    payload = await call_gemini_json(system, json.dumps(prompt))
    if not payload:
        return None

    try:
        what_it_does = clamp_score(payload["what_it_does"])
        why_this_approach = clamp_score(payload["why_this_approach"])
        tradeoffs = clamp_score(payload["tradeoffs"])
        overall = clamp_score(
            payload.get(
                "overall",
                (what_it_does + why_this_approach + tradeoffs) / 3,
            )
        )
        passed = bool(
            payload.get(
                "passed",
                overall >= 0.65
                and min(what_it_does, why_this_approach, tradeoffs) >= 0.4,
            )
        )
        return ComprehensionScore(
            what_it_does=what_it_does,
            why_this_approach=why_this_approach,
            tradeoffs=tradeoffs,
            overall=overall,
            passed=passed,
            feedback=str(payload.get("feedback", "")),
            follow_up_question=payload.get("follow_up_question"),
            concepts_weak=payload.get("concepts_weak", []),
            concepts_strong=payload.get("concepts_strong", []),
            spoken_response=str(payload.get("spoken_response", "")),
        )
    except (TypeError, ValueError, KeyError):
        return None


def evaluate_with_heuristics(
    transcript: str, question: GeneratedQuestion
) -> ComprehensionScore:
    answer = transcript.lower()
    diff_words = {
        word
        for word in re.findall(r"[A-Za-z_][A-Za-z0-9_]{2,}", question.diff_excerpt)
        if word.lower() not in {"const", "return", "import", "from", "true", "false"}
    }
    matched = {word for word in diff_words if word.lower() in answer}
    rationale_words = {"because", "why", "so ", "so that", "prevent", "fix"}
    tradeoff_words = {"tradeoff", "edge", "risk", "test", "bug", "case"}

    what_it_does = min(1.0, 0.25 + len(matched) / max(len(diff_words), 1) * 1.5)
    why_this_approach = 0.7 if any(word in answer for word in rationale_words) else 0.35
    tradeoffs = 0.7 if any(word in answer for word in tradeoff_words) else 0.3
    overall = (what_it_does + why_this_approach + tradeoffs) / 3
    passed = overall >= 0.65 and min(what_it_does, why_this_approach, tradeoffs) >= 0.4

    feedback = (
        "Good direction. You referenced the changed code and gave some rationale."
        if passed
        else "You are not quite there yet. Explain what changed, why it changed, and one edge case or tradeoff."
    )
    follow_up = None if passed else "What specific behavior would break without this change?"

    return ComprehensionScore(
        what_it_does=round(what_it_does, 2),
        why_this_approach=round(why_this_approach, 2),
        tradeoffs=round(tradeoffs, 2),
        overall=round(overall, 2),
        passed=passed,
        feedback=feedback,
        follow_up_question=follow_up,
        concepts_weak=weak_concepts(why_this_approach, tradeoffs) if not passed else [],
        concepts_strong=["changed code references"] if matched else [],
        spoken_response=f"{feedback} {follow_up or 'You can move on to the next checkpoint.'}",
    )


def weak_concepts(why_this_approach: float, tradeoffs: float) -> List[str]:
    concepts = []
    if why_this_approach < 0.4:
        concepts.append("implementation rationale")
    if tradeoffs < 0.4:
        concepts.append("tradeoffs")
    return concepts or ["depth of explanation"]


def clamp_score(value: object) -> float:
    return max(0.0, min(1.0, float(value)))
