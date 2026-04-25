"""ElevenLabs speech helpers."""
import os

import httpx
from fastapi import HTTPException, Response, UploadFile

ELEVENLABS_STT_URL = "https://api.elevenlabs.io/v1/speech-to-text"
ELEVENLABS_TTS_URL = "https://api.elevenlabs.io/v1/text-to-speech/{voice_id}"
ELEVENLABS_STT_MODEL_ID = os.getenv("ELEVENLABS_STT_MODEL", "scribe_v2")
ELEVENLABS_TTS_MODEL_ID = os.getenv("ELEVENLABS_TTS_MODEL", "eleven_multilingual_v2")
ELEVENLABS_TTS_OUTPUT_FORMAT = os.getenv("ELEVENLABS_TTS_OUTPUT_FORMAT", "mp3_44100_128")
ELEVENLABS_VOICE_ID = os.getenv("ELEVENLABS_VOICE_ID", "JBFqnCBsd6RMkjVDRZzb")


async def transcribe_audio(audio: UploadFile) -> dict:
    api_key = get_api_key()

    audio_bytes = await audio.read()
    if not audio_bytes:
        raise HTTPException(status_code=400, detail="Audio upload is empty")

    filename = audio.filename or "answer.webm"
    content_type = audio.content_type or "application/octet-stream"

    try:
        async with httpx.AsyncClient(timeout=60) as client:
            response = await client.post(
                ELEVENLABS_STT_URL,
                headers={"xi-api-key": api_key},
                data={"model_id": ELEVENLABS_STT_MODEL_ID},
                files={"file": (filename, audio_bytes, content_type)},
            )
            response.raise_for_status()
    except httpx.HTTPStatusError as exc:
        raise HTTPException(
            status_code=exc.response.status_code,
            detail=f"ElevenLabs transcription failed: {exc.response.text}",
        ) from exc
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Could not reach ElevenLabs transcription service: {exc}",
        ) from exc

    return response.json()


async def synthesize_speech(text: str, voice_id: str | None = None) -> Response:
    api_key = get_api_key()
    text = text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Text is required")

    selected_voice_id = voice_id or ELEVENLABS_VOICE_ID
    try:
        async with httpx.AsyncClient(timeout=60) as client:
            response = await client.post(
                ELEVENLABS_TTS_URL.format(voice_id=selected_voice_id),
                headers={
                    "xi-api-key": api_key,
                    "accept": "audio/mpeg",
                },
                params={"output_format": ELEVENLABS_TTS_OUTPUT_FORMAT},
                json={"text": text, "model_id": ELEVENLABS_TTS_MODEL_ID},
            )
            response.raise_for_status()
    except httpx.HTTPStatusError as exc:
        raise HTTPException(
            status_code=exc.response.status_code,
            detail=f"ElevenLabs speech generation failed: {exc.response.text}",
        ) from exc
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Could not reach ElevenLabs speech service: {exc}",
        ) from exc

    content_type = response.headers.get("content-type", "")
    if not response.content:
        raise HTTPException(
            status_code=502,
            detail="ElevenLabs speech generation returned an empty audio file",
        )

    if "application/json" in content_type or "text/" in content_type:
        raise HTTPException(
            status_code=502,
            detail=f"ElevenLabs returned non-audio content: {response.text}",
        )

    audio = response.content
    return Response(
        content=audio,
        media_type="audio/mpeg",
        headers={
            "Content-Disposition": 'inline; filename="vibecheck-feedback.mp3"',
            "Content-Length": str(len(audio)),
            "X-VibeCheck-Voice-Id": selected_voice_id,
        },
    )


def get_api_key() -> str:
    api_key = os.getenv("ELEVENLABS_API_KEY")
    if not api_key:
        raise HTTPException(
            status_code=500,
            detail="ELEVENLABS_API_KEY is not configured",
        )
    return api_key
