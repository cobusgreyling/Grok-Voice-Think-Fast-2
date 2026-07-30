#!/usr/bin/env python3
"""Grok Voice Think Fast 2.0 — latency + reasoning showcase (FastAPI)."""

from __future__ import annotations

import asyncio
import base64
import json
import os
import time
from pathlib import Path
from typing import Any

import uvicorn
import websockets
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parent
load_dotenv(ROOT / ".env")

XAI_API_KEY = os.getenv("XAI_API_KEY", "").strip()
MODEL = os.getenv("XAI_VOICE_MODEL", "grok-voice-think-fast-2.0").strip()
VOICE = os.getenv("XAI_VOICE", "eve").strip()
HOST = os.getenv("HOST", "127.0.0.1")
PORT = int(os.getenv("PORT", "7861"))
STATIC_DIR = ROOT / "static"
HEADER_SRC = ROOT / "assets" / "header.jpg"
HEADER_DST = STATIC_DIR / "header.jpg"
PROMPTS_PATH = ROOT / "data" / "prompts.json"
REALTIME_URL = f"wss://api.x.ai/v1/realtime?model={MODEL}"

app = FastAPI(title="Grok Voice Think Fast 2.0 Demo")


def _ensure_header() -> None:
    STATIC_DIR.mkdir(parents=True, exist_ok=True)
    if HEADER_SRC.exists() and (
        not HEADER_DST.exists() or HEADER_SRC.stat().st_mtime > HEADER_DST.stat().st_mtime
    ):
        HEADER_DST.write_bytes(HEADER_SRC.read_bytes())


_ensure_header()
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


class SpeakRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=4000)
    voice: str | None = Field(default=None)
    reasoning_effort: str = Field(default="high", pattern="^(high|none)$")
    instructions: str | None = Field(default=None)


def _require_key() -> str:
    if not XAI_API_KEY:
        raise HTTPException(
            status_code=503,
            detail="XAI_API_KEY is not set. Copy .env.example → .env and add your key.",
        )
    return XAI_API_KEY


@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/api/health")
def health() -> dict[str, Any]:
    key_set = bool(XAI_API_KEY)
    return {
        "ok": key_set,
        "model": MODEL,
        "voice_default": VOICE,
        "key_configured": key_set,
        "realtime_url": REALTIME_URL if key_set else None,
    }


@app.get("/api/examples")
def examples() -> dict[str, Any]:
    if not PROMPTS_PATH.exists():
        return {"examples": []}
    return json.loads(PROMPTS_PATH.read_text(encoding="utf-8"))


@app.post("/api/speak")
async def speak(req: SpeakRequest) -> dict[str, Any]:
    """One-shot text → speech turn. Returns PCM16 base64 + first-audio latency."""
    api_key = _require_key()
    voice = (req.voice or VOICE).strip() or VOICE
    instructions = (
        req.instructions
        or "You are a sharp, concise voice assistant demoing Grok Voice Think Fast 2.0. "
        "Prefer short sentences. No fluff. Answer clearly."
    )

    headers = {"Authorization": f"Bearer {api_key}"}
    audio_chunks: list[bytes] = []
    transcript_parts: list[str] = []
    t_connect = time.perf_counter()
    t_first_audio: float | None = None
    t_done: float | None = None
    events_seen: list[str] = []
    sample_rate = 24000

    try:
        async with websockets.connect(
            REALTIME_URL,
            additional_headers=headers,
            open_timeout=20,
            max_size=16 * 1024 * 1024,
        ) as ws:
            await ws.send(
                json.dumps(
                    {
                        "type": "session.update",
                        "session": {
                            "voice": voice,
                            "instructions": instructions,
                            "reasoning": {"effort": req.reasoning_effort},
                            "turn_detection": None,
                            "audio": {
                                "input": {"format": {"type": "audio/pcm", "rate": sample_rate}},
                                "output": {"format": {"type": "audio/pcm", "rate": sample_rate}},
                            },
                        },
                    }
                )
            )
            await ws.send(
                json.dumps(
                    {
                        "type": "conversation.item.create",
                        "item": {
                            "type": "message",
                            "role": "user",
                            "content": [{"type": "input_text", "text": req.text}],
                        },
                    }
                )
            )
            await ws.send(json.dumps({"type": "response.create"}))

            deadline = time.perf_counter() + 90.0
            while time.perf_counter() < deadline:
                raw = await asyncio.wait_for(ws.recv(), timeout=30.0)
                if isinstance(raw, bytes):
                    if t_first_audio is None:
                        t_first_audio = time.perf_counter()
                    audio_chunks.append(raw)
                    continue

                event = json.loads(raw)
                et = event.get("type", "unknown")
                events_seen.append(et)

                if et in ("response.output_audio.delta", "response.audio.delta"):
                    delta = event.get("delta") or event.get("audio")
                    if delta:
                        if t_first_audio is None:
                            t_first_audio = time.perf_counter()
                        audio_chunks.append(base64.b64decode(delta))
                elif et in (
                    "response.output_audio_transcript.delta",
                    "response.audio_transcript.delta",
                ):
                    part = event.get("delta") or ""
                    if part:
                        transcript_parts.append(part)
                elif et in (
                    "response.output_text.delta",
                    "response.text.delta",
                ):
                    part = event.get("delta") or ""
                    if part:
                        transcript_parts.append(part)
                elif et == "response.done":
                    t_done = time.perf_counter()
                    break
                elif et == "error":
                    raise HTTPException(
                        status_code=502,
                        detail=event.get("error") or event,
                    )
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"Realtime session failed: {exc}") from exc

    if not audio_chunks:
        raise HTTPException(
            status_code=502,
            detail={
                "message": "No audio returned. Check model access and key permissions.",
                "events_seen": events_seen[-20:],
            },
        )

    pcm = b"".join(audio_chunks)
    t_end = t_done or time.perf_counter()
    return {
        "model": MODEL,
        "voice": voice,
        "reasoning_effort": req.reasoning_effort,
        "transcript": "".join(transcript_parts).strip(),
        "sample_rate": sample_rate,
        "format": "audio/pcm; encoding=pcm_s16le; channels=1",
        "audio_base64": base64.b64encode(pcm).decode("ascii"),
        "audio_bytes": len(pcm),
        "duration_s": round(len(pcm) / (sample_rate * 2), 3),
        "metrics": {
            "connect_to_first_audio_s": round((t_first_audio - t_connect), 3)
            if t_first_audio
            else None,
            "connect_to_done_s": round(t_end - t_connect, 3),
            "first_audio_to_done_s": round(t_end - t_first_audio, 3) if t_first_audio else None,
        },
        "events_tail": events_seen[-12:],
    }


@app.websocket("/ws/proxy")
async def voice_proxy(client_ws: WebSocket) -> None:
    """Optional bidirectional proxy for live experiments (browser ↔ xAI)."""
    await client_ws.accept()
    api_key = XAI_API_KEY
    if not api_key:
        await client_ws.send_json({"type": "error", "message": "XAI_API_KEY not configured"})
        await client_ws.close()
        return

    try:
        async with websockets.connect(
            REALTIME_URL,
            additional_headers={"Authorization": f"Bearer {api_key}"},
            open_timeout=20,
            max_size=16 * 1024 * 1024,
        ) as upstream:

            async def client_to_upstream() -> None:
                while True:
                    msg = await client_ws.receive()
                    if msg["type"] == "websocket.disconnect":
                        break
                    if "text" in msg and msg["text"] is not None:
                        await upstream.send(msg["text"])
                    elif "bytes" in msg and msg["bytes"] is not None:
                        await upstream.send(msg["bytes"])

            async def upstream_to_client() -> None:
                async for raw in upstream:
                    if isinstance(raw, bytes):
                        await client_ws.send_bytes(raw)
                    else:
                        await client_ws.send_text(raw)

            done, pending = await asyncio.wait(
                [
                    asyncio.create_task(client_to_upstream()),
                    asyncio.create_task(upstream_to_client()),
                ],
                return_when=asyncio.FIRST_EXCEPTION,
            )
            for task in pending:
                task.cancel()
            for task in done:
                exc = task.exception()
                if exc and not isinstance(exc, (WebSocketDisconnect, asyncio.CancelledError)):
                    raise exc
    except WebSocketDisconnect:
        return
    except Exception as exc:  # noqa: BLE001
        try:
            await client_ws.send_json({"type": "error", "message": str(exc)})
        except Exception:  # noqa: BLE001
            pass
    finally:
        try:
            await client_ws.close()
        except Exception:  # noqa: BLE001
            pass


if __name__ == "__main__":
    uvicorn.run("app:app", host=HOST, port=PORT, reload=False)
