#!/usr/bin/env python3
"""Grok Voice Think Fast 2.0 — interactive Realtime lab (FastAPI)."""

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
DEMO_PATH = ROOT / "data" / "demo-session.json"
REALTIME_URL = f"wss://api.x.ai/v1/realtime?model={MODEL}"

app = FastAPI(title="Grok Voice Think Fast 2.0 Live Lab")


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


class CompareRequest(BaseModel):
    text: str | None = Field(default=None, max_length=4000)
    voice: str | None = Field(default=None)
    instructions: str | None = Field(default=None)
    force_demo: bool = False


def _load_demo() -> dict[str, Any]:
    if not DEMO_PATH.exists():
        raise HTTPException(status_code=404, detail=_friendly_error("demo_missing"))
    return json.loads(DEMO_PATH.read_text(encoding="utf-8"))


def _friendly_error(
    code: str,
    raw: str | None = None,
    *,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Map internal failures to plain-English UI guidance."""
    catalog: dict[str, dict[str, str]] = {
        "missing_key": {
            "title": "API key not configured",
            "message": "The server has no XAI_API_KEY. Use Demo mode without a key, or add one.",
            "fix": "cp .env.example .env  # then set XAI_API_KEY=xai-… from console.x.ai",
        },
        "invalid_key": {
            "title": "API key rejected",
            "message": "xAI rejected the key (unauthorized). Check the value and that Voice is enabled.",
            "fix": "Rotate/create a key at https://console.x.ai/ and update .env",
        },
        "model_access": {
            "title": "Model not available",
            "message": "This key cannot use the voice model. Confirm Realtime / Voice access on the team.",
            "fix": f"Try model pin {MODEL} or switch to Demo mode.",
        },
        "network": {
            "title": "Could not reach xAI Realtime",
            "message": "Network or TLS failed while connecting to api.x.ai.",
            "fix": "Check internet, proxy, VPN, then retry Connect.",
        },
        "timeout": {
            "title": "Timed out waiting for audio",
            "message": "The Realtime session opened but no complete response arrived in time.",
            "fix": "Retry with a shorter prompt, or use Demo mode to verify the UI.",
        },
        "no_audio": {
            "title": "No audio returned",
            "message": "The model responded without playable audio bytes.",
            "fix": "Check model access and try again. Demo mode still works offline.",
        },
        "demo_missing": {
            "title": "Demo fixture missing",
            "message": "data/demo-session.json was not found in the repo checkout.",
            "fix": "Pull latest main or restore data/demo-session.json",
        },
        "mic_denied": {
            "title": "Microphone blocked",
            "message": "The browser denied mic access.",
            "fix": "Allow microphone for this site, or use text chat / Demo mode.",
        },
        "ws_closed": {
            "title": "Session disconnected",
            "message": "The live WebSocket closed unexpectedly.",
            "fix": "Click Connect again. If it repeats, check XAI_API_KEY and server logs.",
        },
        "generic": {
            "title": "Something went wrong",
            "message": raw or "Unexpected error.",
            "fix": "Try Demo mode to confirm the UI, then retry with a key.",
        },
    }
    item = catalog.get(code, catalog["generic"]).copy()
    if raw and code == "generic":
        item["message"] = raw
    payload: dict[str, Any] = {"code": code, **item}
    if raw and code != "generic":
        payload["raw"] = raw[:500]
    if extra:
        payload.update(extra)
    return payload


def _classify_exception(exc: Exception) -> dict[str, Any]:
    text = str(exc)
    low = text.lower()
    if "401" in text or "unauthorized" in low or "invalid api" in low:
        return _friendly_error("invalid_key", text)
    if "403" in text or "permission" in low or "not available" in low or "model" in low and "access" in low:
        return _friendly_error("model_access", text)
    if "timed out" in low or "timeout" in low:
        return _friendly_error("timeout", text)
    if "name or service not known" in low or "connection refused" in low or "network" in low:
        return _friendly_error("network", text)
    return _friendly_error("generic", text)


def _require_key() -> str:
    if not XAI_API_KEY:
        raise HTTPException(status_code=503, detail=_friendly_error("missing_key"))
    return XAI_API_KEY


@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/api/health")
def health() -> dict[str, Any]:
    key_set = bool(XAI_API_KEY)
    demo_ok = DEMO_PATH.exists()
    return {
        "ok": key_set or demo_ok,
        "model": MODEL,
        "voice_default": VOICE,
        "key_configured": key_set,
        "demo_available": demo_ok,
        "mode_recommended": "live" if key_set else "demo",
        "realtime_url": REALTIME_URL if key_set else None,
        "features": [
            "live-session",
            "streaming-audio",
            "mic-vad",
            "multi-turn",
            "scenarios",
            "one-shot-speak",
            "offline-demo",
            "reasoning-compare",
            "friendly-errors",
        ],
    }


@app.get("/api/examples")
def examples() -> dict[str, Any]:
    if not PROMPTS_PATH.exists():
        return {"examples": [], "scenarios": []}
    return json.loads(PROMPTS_PATH.read_text(encoding="utf-8"))


@app.get("/api/demo")
def demo_bundle() -> dict[str, Any]:
    """Full offline session fixture (turns + compare + PCM)."""
    return _load_demo()


async def _speak_once(
    *,
    text: str,
    voice: str,
    reasoning_effort: str,
    instructions: str,
) -> dict[str, Any]:
    api_key = _require_key()
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
        ) as xai_ws:
            await xai_ws.send(
                json.dumps(
                    {
                        "type": "session.update",
                        "session": {
                            "voice": voice,
                            "instructions": instructions,
                            "reasoning": {"effort": reasoning_effort},
                            "turn_detection": None,
                            "audio": {
                                "input": {"format": {"type": "audio/pcm", "rate": sample_rate}},
                                "output": {"format": {"type": "audio/pcm", "rate": sample_rate}},
                            },
                        },
                    }
                )
            )
            await xai_ws.send(
                json.dumps(
                    {
                        "type": "conversation.item.create",
                        "item": {
                            "type": "message",
                            "role": "user",
                            "content": [{"type": "input_text", "text": text}],
                        },
                    }
                )
            )
            await xai_ws.send(json.dumps({"type": "response.create"}))

            deadline = time.perf_counter() + 90.0
            while time.perf_counter() < deadline:
                raw = await asyncio.wait_for(xai_ws.recv(), timeout=30.0)
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
                    err = event.get("error") or event
                    raise RuntimeError(json.dumps(err) if not isinstance(err, str) else err)
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=_classify_exception(exc)) from exc

    if not audio_chunks:
        raise HTTPException(
            status_code=502,
            detail=_friendly_error("no_audio", extra={"events_seen": events_seen[-20:]}),
        )

    pcm = b"".join(audio_chunks)
    t_end = t_done or time.perf_counter()
    return {
        "model": MODEL,
        "voice": voice,
        "reasoning_effort": reasoning_effort,
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
            "first_audio_s": round((t_first_audio - t_connect), 3) if t_first_audio else None,
            "done_s": round(t_end - t_connect, 3),
        },
        "events_tail": events_seen[-12:],
        "source": "live",
    }


@app.post("/api/speak")
async def speak(req: SpeakRequest) -> dict[str, Any]:
    """One-shot text → speech turn (also used by Ctrl/Cmd+Shift+S)."""
    voice = (req.voice or VOICE).strip() or VOICE
    instructions = (
        req.instructions
        or "You are a sharp, concise voice assistant demoing Grok Voice Think Fast 2.0. "
        "Prefer short sentences. No fluff. Answer clearly."
    )
    return await _speak_once(
        text=req.text,
        voice=voice,
        reasoning_effort=req.reasoning_effort,
        instructions=instructions,
    )


@app.post("/api/compare")
async def compare(req: CompareRequest) -> dict[str, Any]:
    """Run the same prompt with reasoning high vs none (live or offline demo)."""
    demo = _load_demo()
    prompt = (req.text or demo.get("compare_prompt") or "").strip()
    if not prompt:
        raise HTTPException(
            status_code=400,
            detail=_friendly_error("generic", "Compare needs a prompt."),
        )

    use_demo = req.force_demo or not XAI_API_KEY
    if use_demo:
        high = demo["compare"]["high"]
        none = demo["compare"]["none"]
        return {
            "source": "demo",
            "prompt": demo.get("compare_prompt") or prompt,
            "model": demo.get("model"),
            "sample_rate": demo.get("sample_rate", 24000),
            "high": {
                "reasoning_effort": "high",
                "transcript": high["transcript"],
                "metrics": high["metrics"],
                "audio_base64": high["audio_base64"],
            },
            "none": {
                "reasoning_effort": "none",
                "transcript": none["transcript"],
                "metrics": none["metrics"],
                "audio_base64": none["audio_base64"],
            },
            "delta_first_audio_s": round(
                high["metrics"]["first_audio_s"] - none["metrics"]["first_audio_s"], 3
            ),
            "note": demo.get("note"),
        }

    voice = (req.voice or VOICE).strip() or VOICE
    instructions = (
        req.instructions
        or "You are a sharp, concise voice assistant. Prefer short sentences. Answer clearly."
    )

    high_res, none_res = await asyncio.gather(
        _speak_once(
            text=prompt,
            voice=voice,
            reasoning_effort="high",
            instructions=instructions,
        ),
        _speak_once(
            text=prompt,
            voice=voice,
            reasoning_effort="none",
            instructions=instructions,
        ),
    )

    h = high_res["metrics"].get("first_audio_s") or high_res["metrics"].get(
        "connect_to_first_audio_s"
    )
    n = none_res["metrics"].get("first_audio_s") or none_res["metrics"].get(
        "connect_to_first_audio_s"
    )
    delta = None
    if h is not None and n is not None:
        delta = round(float(h) - float(n), 3)

    return {
        "source": "live",
        "prompt": prompt,
        "model": MODEL,
        "sample_rate": high_res.get("sample_rate", 24000),
        "high": {
            "reasoning_effort": "high",
            "transcript": high_res["transcript"],
            "metrics": {
                "first_audio_s": h,
                "done_s": high_res["metrics"].get("done_s")
                or high_res["metrics"].get("connect_to_done_s"),
            },
            "audio_base64": high_res["audio_base64"],
        },
        "none": {
            "reasoning_effort": "none",
            "transcript": none_res["transcript"],
            "metrics": {
                "first_audio_s": n,
                "done_s": none_res["metrics"].get("done_s")
                or none_res["metrics"].get("connect_to_done_s"),
            },
            "audio_base64": none_res["audio_base64"],
        },
        "delta_first_audio_s": delta,
        "note": "Live A/B on the same prompt with reasoning.effort high vs none.",
    }


async def _proxy_realtime(client_ws: WebSocket) -> None:
    """Browser ↔ xAI Realtime bidirectional proxy."""
    api_key = XAI_API_KEY
    if not api_key:
        await client_ws.send_json(
            {"type": "error", "error": _friendly_error("missing_key")}
        )
        await client_ws.close()
        return

    try:
        async with websockets.connect(
            REALTIME_URL,
            additional_headers={"Authorization": f"Bearer {api_key}"},
            open_timeout=20,
            max_size=16 * 1024 * 1024,
            ping_interval=20,
            ping_timeout=20,
        ) as upstream:

            async def client_to_upstream() -> None:
                while True:
                    msg = await client_ws.receive()
                    if msg["type"] == "websocket.disconnect":
                        break
                    if msg.get("text") is not None:
                        await upstream.send(msg["text"])
                    elif msg.get("bytes") is not None:
                        await upstream.send(msg["bytes"])

            async def upstream_to_client() -> None:
                async for raw in upstream:
                    if isinstance(raw, bytes):
                        await client_ws.send_bytes(raw)
                    else:
                        await client_ws.send_text(raw)

            tasks = [
                asyncio.create_task(client_to_upstream(), name="client→xai"),
                asyncio.create_task(upstream_to_client(), name="xai→client"),
            ]
            done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in pending:
                task.cancel()
            for task in done:
                exc = task.exception()
                if not exc:
                    continue
                if isinstance(exc, (WebSocketDisconnect, asyncio.CancelledError)):
                    continue
                if type(exc).__name__.startswith("ConnectionClosed"):
                    continue
                raise exc
    except WebSocketDisconnect:
        return
    except Exception as exc:  # noqa: BLE001
        try:
            await client_ws.send_json(
                {"type": "error", "error": _classify_exception(exc)}
            )
        except Exception:  # noqa: BLE001
            pass
    finally:
        try:
            await client_ws.close()
        except Exception:  # noqa: BLE001
            pass


@app.websocket("/ws/session")
async def voice_session(client_ws: WebSocket) -> None:
    """Primary interactive session endpoint used by the live lab UI."""
    await client_ws.accept()
    await _proxy_realtime(client_ws)


@app.websocket("/ws/proxy")
async def voice_proxy(client_ws: WebSocket) -> None:
    """Alias kept for compatibility."""
    await client_ws.accept()
    await _proxy_realtime(client_ws)


if __name__ == "__main__":
    uvicorn.run("app:app", host=HOST, port=PORT, reload=False)
