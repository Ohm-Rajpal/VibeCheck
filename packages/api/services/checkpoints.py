"""Checkpoint generation, lookup, and answer evaluation."""
import json
import os
import re
from typing import Any, List, Optional

from fastapi import HTTPException

from ..schemas.gate import ComprehensionScore, GeneratedQuestion, VerifyRequest
from .gemini import call_gemini_json

SESSION_STORE: dict[str, dict[str, GeneratedQuestion]] = {}
LLM_EXTRA_SYSTEM_INSTRUCTIONS = os.getenv(
    "VIBECHECK_LLM_EXTRA_SYSTEM_INSTRUCTIONS", ""
).strip()
LLM_EXTRA_PROMPT_INSTRUCTIONS = os.getenv(
    "VIBECHECK_LLM_EXTRA_PROMPT_INSTRUCTIONS", ""
).strip()
DEBUG_QUESTION_GEN = os.getenv("VIBECHECK_DEBUG_QUESTION_GEN", "0") == "1"
DEBUG_FLOW = os.getenv("VIBECHECK_DEBUG_FLOW", "0") == "1"


def save_session_questions(session_id: str, questions: List[GeneratedQuestion]) -> None:
    SESSION_STORE[session_id] = {q.checkpoint_id: q for q in questions}


async def generate_questions_with_llm(
    staged_diff: str, local_questions: List[dict]
) -> List[dict]:
    baseline = local_questions if isinstance(local_questions, list) else []
    if DEBUG_FLOW:
        print(
            "[VibeCheck] generate_questions_with_llm start: "
            f"baseline={len(baseline)} stagedDiffChars={len(staged_diff or '')}"
        )
    if not baseline:
        if DEBUG_FLOW:
            print("[VibeCheck] generate_questions_with_llm: empty baseline, returning []")
        return []

    system_base = (
        "You generate high-quality code comprehension questions for developers before commit. "
        "Use provided function context and diff hunks. Keep wording concrete and actionable. "
        "Do not copy template text from input. Rewrite question and whyThisMatters per function. "
        "Return only valid JSON."
    )
    system = (
        f"{system_base}\n\nAdditional system instructions:\n{LLM_EXTRA_SYSTEM_INSTRUCTIONS}"
        if LLM_EXTRA_SYSTEM_INSTRUCTIONS
        else system_base
    )
    prompt: dict[str, Any] = {
        "task": "Generate one strong comprehension question per changed function.",
        "staged_diff": staged_diff,
        "local_questions": baseline,
        "required_json_shape": {
            "questions": [
                {
                    "changedFunction": "string",
                    "changedFunctionFile": "string",
                    "calledBy": ["string"],
                    "estimatedImpact": "Low|Medium|Medium-High|High",
                    "question": "string",
                    "whyThisMatters": "string",
                    "llmContext": {
                        "seed": {
                            "name": "string",
                            "file": "string",
                            "summary": "string",
                            "changedLines": "string",
                            "diff": "string",
                            "snippet": "string",
                        },
                        "impactPath": ["string"],
                        "related": [
                            {
                                "relation": "calls|called_by",
                                "name": "string",
                                "summary": "string",
                                "snippet": "string",
                            }
                        ],
                        "changeType": "logic_change|refactor|bugfix|api_contract|other",
                    },
                }
            ]
        },
    }
    if LLM_EXTRA_PROMPT_INSTRUCTIONS:
        prompt["additional_instructions"] = LLM_EXTRA_PROMPT_INSTRUCTIONS

    payload = await call_gemini_json(system, json.dumps(prompt))
    if not payload:
        if DEBUG_QUESTION_GEN:
            print("[VibeCheck] Question generation fallback: Gemini payload is empty.")
        if DEBUG_FLOW:
            print("[VibeCheck] generate_questions_with_llm: payload is None/empty")
        return []

    if isinstance(payload, list):
        generated = payload
    elif isinstance(payload, dict):
        generated = payload.get("questions")
    else:
        generated = None
    if not isinstance(generated, list):
        if DEBUG_QUESTION_GEN:
            print("[VibeCheck] Question generation fallback: Gemini response missing questions[]")
        if DEBUG_FLOW:
            print(
                "[VibeCheck] generate_questions_with_llm: payload keys="
                f"{list(payload.keys()) if isinstance(payload, dict) else f'<{type(payload).__name__}>'}"
            )
        return []

    normalized = [normalize_generated_question(item) for item in generated]
    merged: List[dict] = []
    for idx, base_item in enumerate(baseline):
        candidate = normalized[idx] if idx < len(normalized) else {}
        merged.append(merge_question_fields(base_item, candidate))
    if DEBUG_QUESTION_GEN:
        print(
            f"[VibeCheck] Question generation complete: baseline={len(baseline)} generated={len(generated)} merged={len(merged)}"
        )
    return merged


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
            llm_context=req.llm_context,
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
    system_base = (
        "You are VibeCheck, a concise senior-engineer oral examiner. "
        "Evaluate whether the developer's spoken answer shows real understanding "
        "of the code diff. Return only valid JSON."
    )
    system = (
        f"{system_base}\n\nAdditional system instructions:\n{LLM_EXTRA_SYSTEM_INSTRUCTIONS}"
        if LLM_EXTRA_SYSTEM_INSTRUCTIONS
        else system_base
    )
    prompt = {
        "question": question.question,
        "transcript": transcript,
        "change_context": normalize_change_context(question),
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
    if LLM_EXTRA_PROMPT_INSTRUCTIONS:
        prompt["additional_instructions"] = LLM_EXTRA_PROMPT_INSTRUCTIONS

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


def normalize_change_context(question: GeneratedQuestion) -> dict:
    raw = question.llm_context if isinstance(question.llm_context, dict) else {}

    seed_raw = raw.get("seed") if isinstance(raw.get("seed"), dict) else {}
    related_raw = raw.get("related") if isinstance(raw.get("related"), list) else []
    impact_path_raw = raw.get("impactPath")
    if not isinstance(impact_path_raw, list):
        impact_path_raw = raw.get("impact_path")
    if not isinstance(impact_path_raw, list):
        impact_path_raw = []

    seed = {
        "name": str(seed_raw.get("name") or question.code_context or "unknown_function"),
        "file": str(seed_raw.get("file") or question.file or "unknown_file"),
        "summary": str(
            seed_raw.get("summary")
            or "Changed function under evaluation for comprehension and downstream impact."
        ),
        "changedLines": str(seed_raw.get("changedLines") or "unknown"),
        "diff": str(seed_raw.get("diff") or question.diff_excerpt or ""),
        "snippet": str(seed_raw.get("snippet") or seed_raw.get("keySnippet") or ""),
    }

    related = []
    for item in related_raw:
        if not isinstance(item, dict):
            continue
        related.append(
            {
                "relation": str(item.get("relation") or "calls"),
                "name": str(item.get("name") or "unknown_function"),
                "summary": str(
                    item.get("summary")
                    or f"Related function in {item.get('relation') or 'calls'} relationship."
                ),
                "snippet": str(item.get("snippet") or item.get("source") or ""),
            }
        )

    impact_path = [str(item) for item in impact_path_raw if item is not None]
    if not impact_path:
        impact_path = [seed["name"]]

    change_type = str(raw.get("changeType") or raw.get("change_type") or "logic_change")

    return {
        "seed": seed,
        "impactPath": impact_path,
        "related": related,
        "changeType": change_type,
        # Keep legacy fields so older prompt readers remain compatible.
        "legacy": {
            "file": question.file,
            "code_context": question.code_context,
            "diff_excerpt": question.diff_excerpt,
        },
    }


def normalize_generated_question(item: Any) -> dict:
    if not isinstance(item, dict):
        return {}
    return {
        "changedFunction": item.get("changedFunction"),
        "changedFunctionFile": item.get("changedFunctionFile"),
        "calledBy": item.get("calledBy")
        if isinstance(item.get("calledBy"), list)
        else [],
        "estimatedImpact": item.get("estimatedImpact"),
        "question": item.get("question"),
        "whyThisMatters": item.get("whyThisMatters"),
        "llmContext": item.get("llmContext")
        if isinstance(item.get("llmContext"), dict)
        else None,
    }


def merge_question_fields(base_item: dict, candidate: dict) -> dict:
    result = dict(base_item) if isinstance(base_item, dict) else {}
    if not isinstance(candidate, dict):
        result["question"] = ""
        result["whyThisMatters"] = ""
        return result

    # Never carry template/base prose forward; these must come from Gemini.
    result["question"] = ""
    result["whyThisMatters"] = ""

    for key in [
        "changedFunction",
        "changedFunctionFile",
        "calledBy",
        "estimatedImpact",
        "question",
        "whyThisMatters",
        "llmContext",
    ]:
        value = candidate.get(key)
        if value not in (None, "", []):
            result[key] = value
    if looks_like_legacy_template(result.get("question")):
        result["question"] = ""
    if looks_like_legacy_template(result.get("whyThisMatters")):
        result["whyThisMatters"] = ""
    return result


def looks_like_legacy_template(value: object) -> bool:
    if not isinstance(value, str):
        return False
    text = value.strip().lower()
    return text.startswith("walk through how `") or text.startswith(
        "this function is directly changed in"
    )
