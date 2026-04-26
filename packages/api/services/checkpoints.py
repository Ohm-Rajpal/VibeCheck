"""Checkpoint generation, lookup, and answer evaluation."""
import json
import os
import re
import uuid
from typing import List, Optional

from fastapi import HTTPException

from ..schemas.gate import (
    ComprehensionScore,
    GeneratedQuestion,
    QuestionRequest,
    VerifyRequest,
)
from .gemini import call_gemini_json

SESSION_STORE: dict[str, dict[str, GeneratedQuestion]] = {}


# ── Grading knobs ─────────────────────────────────────────────────────────
# Read at request time (not import time) so you can tune live during a demo:
#   1. Edit `.env` at the workspace root.
#   2. Change e.g. `VIBECHECK_PASS_THRESHOLD=0.50`.
#   3. Save. Next /gate/verify uses the new value (uvicorn --reload restarts).
#
# Defaults below are intentionally lenient — this is a "did you read what
# the AI wrote?" check, not a senior-engineer oral exam. Bump them up if
# the demo is too forgiving.
def _pass_threshold() -> float:
    return float(os.getenv("VIBECHECK_PASS_THRESHOLD", "0.55"))


def _dimension_floor() -> float:
    # Set to 0 to disable the per-dimension floor entirely (only the
    # overall threshold gates a pass).
    return float(os.getenv("VIBECHECK_DIMENSION_FLOOR", "0.25"))


def _passes(what: float, why: float, tradeoffs: float, overall: float) -> bool:
    floor = _dimension_floor()
    if floor <= 0:
        return overall >= _pass_threshold()
    return overall >= _pass_threshold() and min(what, why, tradeoffs) >= floor
# ──────────────────────────────────────────────────────────────────────────


# ── Calibration examples (few-shot anchors for the grading prompt) ────────
# Three annotated input→output pairs spanning the score range:
#   - EXCELLENT (~0.90): full answer covering what, why, tradeoffs, and
#     repo-level impact.
#   - GOOD (~0.65, PASSES): the kind of answer most engaged developers
#     will give — references specific code, gives one or two real reasons,
#     hints at tradeoffs without fully exploring them. This is the
#     "we're not asking for a thesis" anchor — without it, Gemma tends to
#     compare every answer to the EXCELLENT one and underscore it.
#   - POOR (~0.20, FAILS): vague non-answer with no specifics or rationale.
#
# Choose snippets that have:
#   1. Multiple non-obvious design decisions (so "why" matters)
#   2. Clear edge cases / failure modes (so "tradeoffs" has something to bite into)
#   3. Repo-wide implications (so a great answer naturally references them)
_CALIBRATION_EXAMPLES = [
    {
        "label": "EXCELLENT — score this kind of answer ~0.85 across the board",
        "input": {
            "question": (
                "Why does this wrapper retry only on 5xx and propagate "
                "immediately when signal.aborted is true? What edge case "
                "does the abort check protect against?"
            ),
            "file": "packages/api-client/src/fetchWithRetry.ts",
            "code_context": "fetchWithRetry.ts:1-22",
            "diff_excerpt": (
                "// AI-AUTHORED region (vibecheck-tag: ai-generated, trigger=velocity-burst)\n"
                "export async function fetchWithRetry<T>(\n"
                "  input: RequestInfo,\n"
                "  init: RequestInit & { retries?: number; backoffMs?: number } = {},\n"
                "  signal?: AbortSignal\n"
                "): Promise<T> {\n"
                "  const { retries = 3, backoffMs = 250, ...rest } = init;\n"
                "  let attempt = 0;\n"
                "  while (true) {\n"
                "    try {\n"
                "      const res = await fetch(input, { ...rest, signal });\n"
                "      if (!res.ok && res.status >= 500 && attempt < retries) {\n"
                "        throw new Error(`Retryable ${res.status}`);\n"
                "      }\n"
                "      if (!res.ok) throw new Error(`HTTP ${res.status}`);\n"
                "      return (await res.json()) as T;\n"
                "    } catch (err) {\n"
                "      if (signal?.aborted) throw err;\n"
                "      if (attempt++ >= retries) throw err;\n"
                "      await new Promise(r => setTimeout(r, backoffMs * 2 ** attempt));\n"
                "    }\n"
                "  }\n"
                "}"
            ),
            "transcript": (
                "Retries 5xx because they're transient server failures; 4xx "
                "means the request itself is wrong so retrying would just "
                "spam the server. The `signal.aborted` check stops the retry "
                "loop when a component unmounts — otherwise we'd waste calls "
                "after navigation. Exponential backoff is gentler than linear "
                "on a stressed backend. Main tradeoff: can't retry 429 rate-"
                "limits without adding `Retry-After` handling."
            ),
        },
        "expected_output": {
            "what_it_does": 0.90,
            "why_this_approach": 0.90,
            "tradeoffs": 0.85,
            "overall": 0.88,
            "passed": True,
            "feedback": (
                "Sharp answer — you covered when to retry, why to stop on "
                "abort, and named a real limit. Move on."
            ),
            "follow_up_question": None,
            "concepts_weak": [],
            "concepts_strong": [
                "5xx vs 4xx retry semantics",
                "AbortController integration",
                "exponential backoff",
                "repo-wide consolidation",
            ],
            "spoken_response": (
                "Excellent — you connected the retry policy to abort signals "
                "and to the rest of the codebase. Move on."
            ),
        },
    },
    {
        "label": (
            "CONCISE-GOOD — single-sentence answer, dense, PASSES at ~0.75. "
            "This proves the rule: information density beats length. One "
            "sentence that names specific code, gives the right reason, and "
            "shows edge-case awareness is a STRONG answer. Do NOT score "
            "this lower than EXCELLENT just because it's one sentence — "
            "it covers the same insights more efficiently."
        ),
        "input": {
            "question": (
                "Why does this wrapper retry only on 5xx and propagate "
                "immediately when signal.aborted is true? What edge case "
                "does the abort check protect against?"
            ),
            "file": "packages/api-client/src/fetchWithRetry.ts",
            "code_context": "fetchWithRetry.ts:1-22",
            "diff_excerpt": "(same as above)",
            "transcript": (
                "Retries only on 5xx (transient server failures) with "
                "exponential `backoffMs * 2 ** attempt`, but bails on "
                "`signal.aborted` so React unmounts don't leak retries "
                "past navigation."
            ),
        },
        "expected_output": {
            "what_it_does": 0.85,
            "why_this_approach": 0.80,
            "tradeoffs": 0.65,
            "overall": 0.77,
            "passed": True,
            "feedback": (
                "Excellent density — one sentence, three correct insights. "
                "Exactly the depth we look for."
            ),
            "follow_up_question": None,
            "concepts_weak": [],
            "concepts_strong": [
                "5xx retry rationale",
                "exponential backoff",
                "AbortController integration",
            ],
            "spoken_response": (
                "Sharp — that single sentence covered every angle. Move on."
            ),
        },
    },
    {
        "label": (
            "GOOD — multi-sentence answer, ~0.60-0.70, PASSES. Equivalent "
            "depth to the CONCISE-GOOD above; length is incidental."
        ),
        "input": {
            "question": (
                "Why does this wrapper retry only on 5xx and propagate "
                "immediately when signal.aborted is true? What edge case "
                "does the abort check protect against?"
            ),
            "file": "packages/api-client/src/fetchWithRetry.ts",
            "code_context": "fetchWithRetry.ts:1-22",
            "diff_excerpt": "(same as above)",
            "transcript": (
                "Retries 5xx with `backoffMs * 2 ** attempt` because those "
                "are transient server problems. 4xx means the request is "
                "broken, so retrying wouldn't help. The `signal.aborted` "
                "check stops the loop if the user navigates away."
            ),
        },
        "expected_output": {
            "what_it_does": 0.75,
            "why_this_approach": 0.70,
            "tradeoffs": 0.55,
            "overall": 0.67,
            "passed": True,
            "feedback": (
                "Solid — named the retry policy, the abort case, and why 5xx "
                "is retryable. Good enough."
            ),
            "follow_up_question": None,
            "concepts_weak": ["repo-wide impact"],
            "concepts_strong": [
                "5xx retry rationale",
                "AbortController integration",
                "exponential backoff",
            ],
            "spoken_response": (
                "Nice — you've got the core ideas. Move on to the next "
                "checkpoint."
            ),
        },
    },
    {
        "label": "POOR — score this kind of answer ~0.2-0.3, do NOT pass",
        "input": {
            "question": (
                "Why does this wrapper retry only on 5xx and propagate "
                "immediately when signal.aborted is true? What edge case "
                "does the abort check protect against?"
            ),
            "file": "packages/api-client/src/fetchWithRetry.ts",
            "code_context": "fetchWithRetry.ts:1-22",
            "diff_excerpt": "(same as above)",
            "transcript": "It tries to fetch something and retries if it fails.",
        },
        "expected_output": {
            "what_it_does": 0.30,
            "why_this_approach": 0.20,
            "tradeoffs": 0.10,
            "overall": 0.20,
            "passed": False,
            "feedback": (
                "You named the broad shape but missed every design decision "
                "in the code — try pointing to one specific line and explaining "
                "why it's there."
            ),
            "follow_up_question": (
                "What specifically would happen if signal.aborted weren't "
                "checked inside the catch?"
            ),
            "concepts_weak": [
                "5xx vs 4xx distinction",
                "abort signal handling",
                "retry policy",
            ],
            "concepts_strong": [],
            "spoken_response": (
                "Take another pass — focus on why retries are gated on the "
                "status code and the abort signal."
            ),
        },
    },
]
# ──────────────────────────────────────────────────────────────────────────


def save_session_questions(session_id: str, questions: List[GeneratedQuestion]) -> None:
    SESSION_STORE[session_id] = {q.checkpoint_id: q for q in questions}


def remember_question(question: GeneratedQuestion, session_id: str) -> None:
    """Persist a single question so a later /gate/verify can look it up by id."""
    SESSION_STORE.setdefault(session_id, {})[question.checkpoint_id] = question


async def generate_question(req: QuestionRequest) -> GeneratedQuestion:
    """Ask the model to produce ONE design-choice question grounded in the
    AI-authored code. We deliberately steer the model away from "what does
    this do" surface trivia and toward "why this approach / what tradeoffs"
    so the user has to demonstrate real comprehension, not pattern-match.
    """
    checkpoint_id = req.checkpoint_id or f"q-{uuid.uuid4().hex[:8]}"
    location = (
        f"{req.file}:{req.start_line + 1}-{req.end_line + 1}"
        if req.end_line >= req.start_line
        else req.file
    )

    system = (
        "You are VibeCheck, a supportive code reviewer helping an intern or "
        "non-technical builder understand the AI code they just shipped. "
        "Your job is to ask ONE focused question that helps them OWN this "
        "code — not gatekeep them on senior-engineer vocabulary.\n\n"
        "AUDIENCE: interns, junior engineers, designers writing code, PMs "
        "prototyping. They can READ the code and reason about it. They may "
        "NOT know terms like 'idempotent', 'race condition', "
        "'AbortController', 'memoization', etc.\n\n"
        "ANTI-GAMING (THE MOST IMPORTANT RULE):\n"
        "  Assume the user prompted the AI with something like 'write me a "
        "  memoize function' or 'add retry logic'. Your question MUST NOT "
        "  be answerable by paraphrasing that prompt. Target a SPECIFIC "
        "  IMPLEMENTATION CHOICE the AI made WITHOUT being asked — a "
        "  literal value, an operator choice, an early-exit branch, a "
        "  serialization decision, an error-handling path. If your "
        "  question is at the GOAL level ('why retry?', 'why cache?', "
        "  'why debounce?'), you've FAILED. Go one level deeper into "
        "  the code's actual implementation.\n\n"
        "Hard rules:\n"
        "  - Ask something they can answer by READING the code in front of "
        "them. Don't require knowledge of an alternative they've never seen.\n"
        "  - The question MUST quote at least one specific identifier, "
        "literal, or operator from the code in backticks. Generic questions "
        "that could apply to ANY code are rejected.\n"
        "  - Prefer 'what would happen if you removed Y' / 'why is `value` "
        "set to X here' / 'why use `A` instead of `B` for the key' framings.\n"
        "  - Avoid jargon in the QUESTION itself. Don't say 'race condition' "
        "— say 'what could go wrong if two of these run at once'. Don't say "
        "'memoize' — say 'why is the result stored'.\n"
        "  - Be concise: ONE question, max ~25 words. They're shipping fast, "
        "so don't make them parse a paragraph.\n"
        "  - Match the calibration examples below in shape and specificity."
    )

    payload = {
        "file": req.file,
        "language": req.language or "unknown",
        "location": location,
        "code": req.code,
        "calibration_examples": _QUESTION_CALIBRATION_EXAMPLES,
        "required_json_shape": {
            "question": "the design-choice question, max 30 words, MUST cite a specific identifier from the code in backticks",
            "concept_tag": "1-3 word tag, e.g. 'memoization', 'AbortController', 'optimistic update'",
            "rationale": "1 sentence: why this question reveals comprehension",
        },
    }

    response = await call_gemini_json(system, json.dumps(payload))
    if response and response.get("question"):
        question_text = str(response["question"]).strip()
        concept_tag = str(response.get("concept_tag") or "design choice").strip()
    else:
        # Heuristic fallback. We extract an actual identifier from the code so
        # the question still references something specific instead of being
        # the same generic prompt every time.
        print(
            f"[checkpoints] WARN: Gemma question fallback firing for "
            f"{location} — check API key + model name."
        )
        question_text, concept_tag = _heuristic_question_fallback(
            req.code, location
        )

    question = GeneratedQuestion(
        checkpoint_id=checkpoint_id,
        question=question_text,
        concept_tag=concept_tag,
        code_context=location,
        file=req.file,
        diff_excerpt=req.code,
    )
    remember_question(question, req.session_id)
    return question


def _heuristic_question_fallback(code: str, location: str) -> tuple[str, str]:
    """Pick a meaningful identifier from the code and build a question
    referencing it. Used only when Gemma is unreachable or returns garbage.
    Better than a static 'why this approach' for every region."""
    skip = {
        "function", "const", "let", "var", "return", "class", "this", "else",
        "true", "false", "null", "void", "import", "from", "export", "default",
        "async", "await", "throw", "catch", "while", "for", "case", "break",
        "continue", "switch", "typeof", "instanceof", "string", "number",
    }
    candidates = re.findall(r"\b[A-Za-z_][A-Za-z0-9_]{3,}\b", code)
    # Prefer camelCase / PascalCase (likely user-defined) over generic words.
    interesting = [
        ident
        for ident in candidates
        if ident.lower() not in skip
        and (any(c.isupper() for c in ident[1:]) or "_" in ident)
    ]
    chosen = interesting[0] if interesting else (
        next((c for c in candidates if c.lower() not in skip), None)
    )

    if chosen:
        question = (
            f"In {location}, why does the code use `{chosen}` here? "
            f"What edge case would break if you removed it?"
        )
        concept_tag = chosen
    else:
        question = (
            f"In {location}, name the single most non-obvious choice in "
            f"this snippet and explain why it's there."
        )
        concept_tag = "design choice"
    return question, concept_tag


# Few-shot anchors for the question-generation prompt. Same idea as the
# grading anchors — show Gemma what a SPECIFIC, code-grounded question
# looks like vs a generic one, so its output stops looking like a template.
_QUESTION_CALIBRATION_EXAMPLES = [
    {
        "label": (
            "GOOD — intern-friendly. Specific identifier in backticks, "
            "answerable by reading the code, no senior-eng vocabulary."
        ),
        "input": {
            "code": (
                "export function useDebouncedQuery<T>(input: string, ms = 250) {\n"
                "  const [debounced, setDebounced] = useState(input);\n"
                "  useEffect(() => {\n"
                "    const id = setTimeout(() => setDebounced(input), ms);\n"
                "    return () => clearTimeout(id);\n"
                "  }, [input, ms]);\n"
                "  return debounced;\n"
                "}"
            )
        },
        "expected_output": {
            "question": (
                "What would happen if you removed the `clearTimeout(id)` "
                "line and the user typed quickly?"
            ),
            "concept_tag": "timer cleanup",
            "rationale": (
                "Answerable by reading the code — they can reason about "
                "stacked timers without knowing the term 'race condition'."
            ),
        },
    },
    {
        "label": (
            "GOOD — intern-friendly. Asks WHY a specific value was chosen, "
            "answerable from the code itself."
        ),
        "input": {
            "code": (
                "def memoize(fn):\n"
                "    cache = {}\n"
                "    def wrapper(*args):\n"
                "        key = json.dumps(args, sort_keys=True)\n"
                "        if key not in cache:\n"
                "            cache[key] = fn(*args)\n"
                "        return cache[key]\n"
                "    return wrapper"
            )
        },
        "expected_output": {
            "question": (
                "Why use `json.dumps(args, sort_keys=True)` as the key "
                "instead of just `args`? What input would behave wrong "
                "without `sort_keys`?"
            ),
            "concept_tag": "cache key",
            "rationale": (
                "Targets a specific AI choice (sort_keys, JSON serialization) "
                "the user could not have asked for. Forces them to read the "
                "actual implementation, not just remember the goal."
            ),
        },
    },
    {
        "label": "BAD — generic 'walk me through' that we DO NOT WANT",
        "input": {
            "code": "(any code)"
        },
        "expected_output": {
            "question": "Walk me through what this code does.",
            "concept_tag": "explanation",
            "rationale": "REJECTED — surface narration, not comprehension.",
        },
    },
    {
        "label": "BAD — generic that could apply to anything",
        "input": {
            "code": "(any code)"
        },
        "expected_output": {
            "question": (
                "Why this approach instead of an obvious alternative? "
                "Name one edge case it handles."
            ),
            "concept_tag": "design choice",
            "rationale": (
                "REJECTED — does not cite any identifier from the code; "
                "indistinguishable from a template."
            ),
        },
    },
    {
        "label": (
            "BAD — GAMEABLE. Asks about the GOAL of the function, which the "
            "user could answer by paraphrasing their original prompt to the "
            "AI ('I asked for a memoize function'). This proves nothing "
            "about whether they read the implementation. ALWAYS REJECT."
        ),
        "input": {
            "code": (
                "def memoize(fn):\n"
                "    cache = {}\n"
                "    def wrapper(*args):\n"
                "        key = json.dumps(args, sort_keys=True)\n"
                "        if key not in cache:\n"
                "            cache[key] = fn(*args)\n"
                "        return cache[key]\n"
                "    return wrapper"
            )
        },
        "expected_output": {
            "question": (
                "Why does the code store `fn(*args)` in `cache`?"
            ),
            "concept_tag": "result caching",
            "rationale": (
                "REJECTED — this is the function's PURPOSE, which the user "
                "literally asked the AI for. Pivot to an implementation "
                "detail like why `json.dumps` is used, why `sort_keys=True`, "
                "why the cache lives inside the closure, etc."
            ),
        },
    },
]


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
    threshold = _pass_threshold()
    floor = _dimension_floor()

    # Generous, encouraging examiner. The product goal is "engineer engaged
    # with the AI code", NOT "engineer passed a senior interview". Partial
    # credit matters; missing tradeoffs alone should never fail an answer
    # that nails what + why.
    system = (
        "You are VibeCheck, a supportive code reviewer helping an intern or "
        "non-technical builder understand the AI code they just shipped. "
        "The product mission: they OWN the code the AI wrote, not the "
        "other way around. They're moving fast — your job is to confirm "
        "they understand what's there, NOT to gatekeep them on jargon.\n\n"
        "AUDIENCE:\n"
        "  Interns, junior engineers, designers writing code, PMs prototyping. "
        "  They may not know terms like 'idempotent', 'transient 5xx', "
        "  'race condition', or 'AbortController'. They CAN read the code "
        "  and reason about what it does.\n\n"
        "SCORING RULES:\n"
        "  1. DEPTH, NOT LENGTH. A single dense sentence that names specific "
        "     code and explains a real reason scores 0.7+. A long rambling "
        "     answer with no specifics is WEAK. Never penalize brevity.\n"
        "  2. LAYPERSON-CORRECT IS CORRECT. 'When the server has problems' "
        "     deserves the same credit as 'transient 5xx server errors'. "
        "     Credit the CONCEPT, not the vocabulary. 'We stop if the user "
        "     clicked away' = 'AbortController prevents leaked retries'.\n"
        "  3. BE A MENTOR. Pass if they show they read the code and got "
        "     the gist. Fail only if they clearly didn't read it or are "
        "     wrong. The product goal is forward momentum + ownership, "
        "     not interview prep.\n\n"
        "Anchor to calibration_examples: the CONCISE-GOOD example is your "
        "default reference — most engaged answers should score around "
        "0.7 and pass. Reserve EXCELLENT-tier (0.85+) for answers that "
        "show senior-level depth. Reserve POOR-tier (<0.4) for vague "
        "non-answers that don't reference the code at all.\n\n"
        "Feedback should be encouraging and forward-looking — they're "
        "shipping, not interviewing. Never comment on length, only "
        "content.\n\n"
        "VOCABULARY RULE — teach, don't hide:\n"
        "  Use real technical terms in `feedback`, `spoken_response`, "
        "  and `concepts_*`. Don't dumb them down. BUT when you use a "
        "  term the user didn't, briefly tie it to what they said so "
        "  they learn the word. Example: user says 'we save the result "
        "  so we don't redo work', good feedback is 'Exactly — that's "
        "  memoization: caching the result so we don't recompute for "
        "  the same input'. Naming the term + grounding it in their own "
        "  words is how they end up OWNING the concept. The goal is "
        "  growth, not coddling.\n\n"
        "Return only valid JSON."
    )
    prompt = {
        "question": question.question,
        "file": question.file,
        "code_context": question.code_context,
        "diff_excerpt": question.diff_excerpt,
        "transcript": transcript,
        "rubric": {
            "what_it_does": (
                "0.7+ if they describe what the code does in their OWN words "
                "(referencing identifiers, values, or behavior they can see). "
                "Layperson-correct counts: 'it stops the timer' is just as "
                "valid as 'it cancels the pending setTimeout'. "
                "0.4-0.6 if vague but in the right ballpark. "
                "<0.4 only if the description is wrong or about unrelated code."
            ),
            "why_this_approach": (
                "0.7+ for ANY plausible reason — performance, avoiding bugs, "
                "matching how the rest of the code works, etc. They don't need "
                "to use words like 'idempotent' or 'invariant'; 'so it doesn't "
                "do the same work twice' is a complete answer. "
                "0.4-0.6 for a vague gesture at intent. <0.4 only for a "
                "clearly wrong rationale."
            ),
            "tradeoffs": (
                "0.7+ if they name ANY edge case, limitation, or alternative — "
                "in any vocabulary. 'It would break if X happens' counts. "
                "0.4-0.6 if they hint at one. 0.2-0.4 if they don't mention "
                "any. BONUS dimension only — absence alone NEVER fails the "
                "answer; a strong what+why is enough to pass."
            ),
            "passed": (
                f"True when overall >= {threshold} "
                f"and no dimension is below {floor} "
                "(so a strong what+why with weak tradeoffs still passes)."
            ),
            "tone": (
                "Feedback should be one short, encouraging sentence. If "
                "passed, acknowledge what they got right. If not, point "
                "out the SINGLE most useful thing to say next time. "
                "NEVER comment on answer length — only on content."
            ),
        },
        "calibration_examples": _CALIBRATION_EXAMPLES,
        "required_json_shape": {
            "what_it_does": 0.0,
            "why_this_approach": 0.0,
            "tradeoffs": 0.0,
            "overall": 0.0,
            "passed": False,
            "feedback": "short encouraging text",
            "follow_up_question": "short text or null (null if passed)",
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
        # Server-side passed decision OVERRIDES whatever Gemma returned —
        # this way the env-var threshold is the single source of truth.
        passed = _passes(what_it_does, why_this_approach, tradeoffs, overall)
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

    what_it_does = min(1.0, 0.35 + len(matched) / max(len(diff_words), 1) * 1.5)
    why_this_approach = 0.75 if any(word in answer for word in rationale_words) else 0.45
    tradeoffs = 0.75 if any(word in answer for word in tradeoff_words) else 0.35
    overall = (what_it_does + why_this_approach + tradeoffs) / 3
    passed = _passes(what_it_does, why_this_approach, tradeoffs, overall)

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
