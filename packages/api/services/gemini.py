"""Gemini JSON-generation client."""
import json
import os
import re
from typing import Optional

import httpx
from fastapi import HTTPException

GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
GEMINI_GENERATE_URL = (
    "https://generativelanguage.googleapis.com/v1beta/models/"
    f"{GEMINI_MODEL}:generateContent"
)


async def call_gemini_json(system: str, prompt: str) -> Optional[dict]:
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        return None

    try:
        async with httpx.AsyncClient(timeout=60) as client:
            response = await client.post(
                GEMINI_GENERATE_URL,
                headers={
                    "x-goog-api-key": api_key,
                    "content-type": "application/json",
                },
                json={
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
                },
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

    candidates = response.json().get("candidates", [])
    parts = candidates[0].get("content", {}).get("parts", []) if candidates else []
    text = "".join(part.get("text", "") for part in parts)
    return extract_json_object(text)


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
