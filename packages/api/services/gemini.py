"""Gemini JSON-generation client."""
import json
import os
import re
from typing import Any, Optional

import httpx
from fastapi import HTTPException

GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemma-4-26b-a4b-it")
GEMINI_GENERATE_URL = (
    "https://generativelanguage.googleapis.com/v1beta/models/"
    f"{GEMINI_MODEL}:generateContent"
)
DEBUG_GEMINI_REQUEST = os.getenv("VIBECHECK_DEBUG_GEMINI_REQUEST", "0") == "1"
DEBUG_GEMINI_RESPONSE = os.getenv("VIBECHECK_DEBUG_GEMINI_RESPONSE", "0") == "1"
DEBUG_FLOW = os.getenv("VIBECHECK_DEBUG_FLOW", "0") == "1"


async def call_gemini_json(system: str, prompt: str) -> Optional[Any]:
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        if DEBUG_FLOW:
            print("[VibeCheck] call_gemini_json skipped: GEMINI_API_KEY is missing")
        return None
    if DEBUG_FLOW:
        print(
            "[VibeCheck] call_gemini_json start: "
            f"systemChars={len(system)} promptChars={len(prompt)} model={GEMINI_MODEL}"
        )

    request_json = {
        "systemInstruction": {
            "parts": [{"text": system}],
        },
        "contents": [
            {
                "role": "user",
                "parts": [{"text": prompt}],
            }
        ],
        "generationConfig": {
            "temperature": 0.2,
            "maxOutputTokens": 1200,
            "responseMimeType": "application/json",
        },
    }
    if DEBUG_GEMINI_REQUEST:
        debug_headers = {
            "x-goog-api-key": redact_api_key(api_key),
            "content-type": "application/json",
        }
        print("[VibeCheck] Gemini request URL:", GEMINI_GENERATE_URL)
        print("[VibeCheck] Gemini request headers:", json.dumps(debug_headers))
        print("[VibeCheck] Gemini request body:", json.dumps(request_json, indent=2))

    try:
        async with httpx.AsyncClient(timeout=60) as client:
            response = await client.post(
                GEMINI_GENERATE_URL,
                headers={
                    "x-goog-api-key": api_key,
                    "content-type": "application/json",
                },
                json=request_json,
            )
            response.raise_for_status()
    except httpx.HTTPStatusError as exc:
        raise HTTPException(
            status_code=exc.response.status_code,
            detail=f"Gemini request failed: {exc.response.text}",
        ) from exc
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Could not reach Gemini: {exc}",
        ) from exc

    response_json = response.json()
    if DEBUG_GEMINI_RESPONSE:
        print("[VibeCheck] Gemini raw response:", json.dumps(response_json, indent=2))

    candidates = response_json.get("candidates", [])
    parts = candidates[0].get("content", {}).get("parts", []) if candidates else []
    text = "".join(part.get("text", "") for part in parts)
    parsed = extract_json_object(text)
    if DEBUG_FLOW:
        print(
            "[VibeCheck] call_gemini_json parsed response: "
            f"textChars={len(text)} parsed={'yes' if parsed is not None else 'no'}"
        )
    return parsed


def extract_json_object(text: str) -> Optional[Any]:
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    array_match = re.search(r"\[.*\]", text, flags=re.DOTALL)
    if array_match:
        try:
            return json.loads(array_match.group(0))
        except json.JSONDecodeError:
            pass

    match = re.search(r"\{.*\}", text, flags=re.DOTALL)
    if not match:
        return None

    try:
        return json.loads(match.group(0))
    except json.JSONDecodeError:
        return None


def redact_api_key(api_key: str) -> str:
    if len(api_key) <= 8:
        return "***"
    return f"{api_key[:4]}...{api_key[-4:]}"
