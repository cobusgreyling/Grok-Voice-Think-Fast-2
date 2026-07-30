# Grok Voice Think Fast 2.0 // Live Lab

Interactive article companion for **xAI Grok Voice Think Fast 2.0** — a persistent speech-to-speech session you can drive with text, mic, and scenario chips.

![Header](assets/header.jpg)

**Article:** [`BLOG.md`](BLOG.md)  
**Announcement:** [x.ai/news/grok-voice-think-fast-2](https://x.ai/news/grok-voice-think-fast-2)

## What you can do in the UI

| Feature | How |
|--------|-----|
| **Live multi-turn session** | Click **Connect** — one WebSocket stays open |
| **Streaming playback** | Audio plays as `response.output_audio.delta` arrives |
| **Mic + server VAD** | **Mic on** streams PCM; auto turn-taking when VAD is enabled |
| **Barge-in / interrupt** | Speak over the agent, or hit **Interrupt** |
| **Scenarios** | One-click support / sales / reasoning / multilingual personas |
| **Live settings** | Change voice, reasoning (`high`/`none`), instructions mid-session |
| **Latency sparkline** | Per-turn send → first audio + avg, with 0.70s lab reference |
| **Event stream** | Raw Realtime events for debugging |
| **One-shot fallback** | `Ctrl/Cmd+Shift+S` hits `/api/speak` without a live session |

## Prerequisites

- Python 3.10+
- xAI API key with Voice / Realtime access from [console.x.ai](https://console.x.ai/)
- Browser with microphone permission (for live voice)

## Quick start

```bash
python3 -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt

cp .env.example .env
# set XAI_API_KEY=xai-...

python app.py
# or: ./run.sh
```

Open **http://127.0.0.1:7861**

1. Confirm **API key configured**
2. Click **Connect**
3. Send a text message, click a scenario, or enable the **mic**
4. Watch first-audio latency and the conversation stream

## Environment

| Variable | Default | Description |
|----------|---------|-------------|
| `XAI_API_KEY` | _(required)_ | xAI API key |
| `XAI_VOICE_MODEL` | `grok-voice-think-fast-2.0` | Realtime model id |
| `XAI_VOICE` | `eve` | Default voice |
| `HOST` | `127.0.0.1` | Bind address |
| `PORT` | `7861` | HTTP port |

## API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | Live lab UI |
| `GET` | `/api/health` | Key / model / feature flags |
| `GET` | `/api/examples` | Prompt chips + scenarios |
| `POST` | `/api/speak` | One-shot text → speech + metrics |
| `WS` | `/ws/session` | Interactive Realtime proxy (primary) |
| `WS` | `/ws/proxy` | Alias of `/ws/session` |

## Architecture

```text
Browser (mic / text / UI)
    │  WebSocket JSON + PCM
    ▼
FastAPI /ws/session  ──proxy──►  wss://api.x.ai/v1/realtime?model=grok-voice-think-fast-2.0
```

The API key stays on the server. For production browser apps, prefer [ephemeral tokens](https://docs.x.ai/developers/model-capabilities/audio/ephemeral-tokens).

## Security

- Never commit `.env` or paste live keys into screenshots.
- This lab binds to localhost by default.
- Rotate any key that was shared in chat.

## Stack

- FastAPI + Uvicorn
- `websockets` client → xAI Realtime Speech-to-Speech API
- Vanilla HTML/CSS/JS (streaming PCM player, waveform, sparkline)

## Related

- Docs: [Speech to Speech](https://docs.x.ai/developers/model-capabilities/audio/voice-agent)
- Voice Agent Builder: [x.ai/voice](https://x.ai/voice)
- Benchmarks: [Artificial Analysis](https://artificialanalysis.ai/speech-to-speech)

## License

MIT — see companion article for attribution of xAI product claims and benchmark figures.
