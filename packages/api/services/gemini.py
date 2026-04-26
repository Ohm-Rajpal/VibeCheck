"""LLM JSON-generation client.

Hits the Google `generativelanguage.googleapis.com` v1beta endpoint, which
serves both Gemini and Gemma models on the same surface. We default to a
Gemma 4 model (open weights, free tier via MLH AI Studio key) but the call
shape is identical for Gemini, so any model exposed at that endpoint works.

Behavioural difference between the two families that matters here:
  - Gemini supports `responseMimeType: "application/json"` to force valid
    JSON output.
  - Gemma does NOT support that field. Instead we prepend a strict
    "respond ONLY with a JSON object" instruction and rely on
    `extract_json_object` to recover the payload from any wrapper text
    (markdown fences, prose, etc.) the model emits.
"""
import json
import os
import re
from typing import Optional

import httpx
from fastapi import HTTPException

# Default to Gemma 4 (free, open weights, hosted on Google AI Studio).
# Override with GEMINI_MODEL=gemini-2.5-flash to switch back to Gemini for
# regression testing.
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemma-4-26b-a4b-it")
GEMINI_GENERATE_URL = (
    "https://generativelanguage.googleapis.com/v1beta/models/"
    f"{GEMINI_MODEL}:generateContent"
)

_IS_GEMMA = GEMINI_MODEL.lower().startswith("gemma")


async def call_gemini_json(system: str, prompt: str) -> Optional[dict]:
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        return None

    generation_config: dict = {
        "temperature": 0.2,
        "maxOutputTokens": 1200,
    }
    if not _IS_GEMMA:
        # Gemini supports forced-JSON; Gemma rejects this field.
        generation_config["responseMimeType"] = "application/json"
        effective_system = system
    else:
        # Reinforce the JSON contract via the system prompt for Gemma.
        effective_system = (
            f"{system}\n\n"
            "Output requirement: respond with EXACTLY ONE JSON object and "
            "no surrounding prose, code fences, or commentary. Do not wrap "
            "the JSON in ```json ... ``` fences."
        )

    # 10s is the practical ceiling for a UI-driven question/grade call.
    # Override via VIBECHECK_GEMINI_TIMEOUT if the demo machine has slow
    # internet — but 60s (the old default) was way too long: the user just
    # sees a frozen UI before the heuristic fallback fires.
    timeout = float(os.getenv("VIBECHECK_GEMINI_TIMEOUT", "10"))

    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.post(
                GEMINI_GENERATE_URL,
                headers={
                    "x-goog-api-key": api_key,
                    "content-type": "application/json",
                },
                json={
                    "systemInstruction": {
                        "parts": [{"text": effective_system}],
                    },
                    "contents": [
                        {
                            "role": "user",
                            "parts": [{"text": prompt}],
                        }
                    ],
                    "generationConfig": generation_config,
                },
            )
            response.raise_for_status()
    except httpx.HTTPStatusError as exc:
        # Log to uvicorn so we can finally SEE why Gemma rejected the call
        # (most common: invalid model name returns 404 with "model not found").
        print(
            f"[gemini] {GEMINI_MODEL} → {exc.response.status_code} "
            f"{exc.response.text[:500]}"
        )
        # Return None instead of raising — caller will use heuristic fallback
        # and the UI stays responsive. Re-enable raising for hard debugging.
        return None
    except httpx.HTTPError as exc:
        print(f"[gemini] {GEMINI_MODEL} unreachable: {exc}")
        return None

    raw = response.json()
    candidates = raw.get("candidates", [])
    parts = candidates[0].get("content", {}).get("parts", []) if candidates else []
    text = "".join(part.get("text", "") for part in parts)
    parsed = extract_json_object(text)
    if parsed is None:
        # Log enough of the raw response to debug "Gemma replied but we
        # couldn't extract JSON" cases — common when the model wraps in
        # markdown despite the system instruction or hits an output filter.
        print(
            f"[gemini] {GEMINI_MODEL} returned non-JSON output "
            f"(first 300 chars): {text[:300]!r}"
        )
    return parsed


def extract_json_object(text: str) -> Optional[dict]:
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    match = re.search(r"\{.*\}", text, flags=re.DOTALL)
    if not match:
        return None

    try:
        return json.loads(match.group(0))
    except json.JSONDecodeError:
        return None
