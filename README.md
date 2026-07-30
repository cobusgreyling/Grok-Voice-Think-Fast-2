# Grok Voice Think Fast 2.0 — Live Lab

Interactive companion for [xAI Grok Voice Think Fast 2.0](https://x.ai/news/grok-voice-think-fast-2) — push-to-talk, tool calls, offline demo, reasoning A/B, and session export.

**Read the article → [`BLOG.md`](BLOG.md)**

![Live lab UI](assets/ui-preview.jpg)

## 30-second start

```bash
git clone https://github.com/cobusgreyling/Grok-Voice-Think-Fast-2.git
cd Grok-Voice-Think-Fast-2
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python app.py
```

Open **http://127.0.0.1:7861** → **▶ Demo mode** (no API key).

### Or Docker

```bash
docker compose up --build
# → http://127.0.0.1:7861  (Demo mode works with no key)
```

Live voice (optional):

```bash
cp .env.example .env   # set XAI_API_KEY=xai-… from https://console.x.ai/
# python app.py   OR   docker compose up --build
# → Connect → hold Space to talk
```

## What you can do

| Feature | How |
|--------|-----|
| **Push-to-talk** | Hold **Space** or **Hold to talk** (default mic mode — noisy rooms / demos) |
| **Open mic + VAD** | Mic mode → open mic, then **Open mic** |
| **AudioWorklet capture** | Mic → 24 kHz PCM (no deprecated ScriptProcessor) |
| **Tool calls** | `lookup_order` (local fake CRM) + optional `web_search` — chips in chat |
| **Export session** | **⬇ Export** → transcript + latency + tools JSON |
| **Offline Demo mode** | No key — recorded turns + tool chip + latency sparkline |
| **Compare high vs none** | Same prompt, two reasoning settings |
| **Friendly errors** | Missing key / mic / network → plain English + fix |

### Tool demo prompts

- `Where is order 88421? Use your order lookup tool…`
- Scenario chip **🎧 Support + tools**
- In Demo mode, type anything with `88421` or `4491` to force a local tool chip

### Export shape

```json
{
  "exported_at": "…",
  "metrics_summary": { "turns": 3, "avg_first_audio_s": 0.74 },
  "transcript": [{ "role": "user", "text": "…" }],
  "latency": [{ "first_audio_s": 0.72 }],
  "tools": [{ "name": "lookup_order", "arguments": {}, "result": {} }]
}
```

## Why this exists

Think Fast 2.0’s claim: **reason while speaking** without the usual latency tax.

- Lab TTFA: **~0.70s** first audio (vs 1.25s on 1.0)
- Stronger conversational dynamics and agentic scores
- ~**0.4×** relative reasoning tokens vs 1.0

Details: **[BLOG.md](BLOG.md)**.

## Environment

| Variable | Default | Description |
|----------|---------|-------------|
| `XAI_API_KEY` | _(optional for demo)_ | Required for live Connect / mic / live tools |
| `XAI_VOICE_MODEL` | `grok-voice-think-fast-2.0` | Realtime model id |
| `XAI_VOICE` | `eve` | Default voice |
| `HOST` / `PORT` | `127.0.0.1` / `7861` | Bind (`0.0.0.0` in Docker) |

## API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | Live lab UI |
| `GET` | `/api/health` | Key / demo / features |
| `GET` | `/api/demo` | Offline fixture |
| `GET` | `/api/examples` | Prompts + scenarios |
| `POST` | `/api/speak` | One-shot text → speech |
| `POST` | `/api/compare` | Reasoning high vs none |
| `WS` | `/ws/session` | Live Realtime proxy |

## Architecture

```text
Browser (PTT / open mic via AudioWorklet)
    │  WebSocket JSON + PCM16 @ 24 kHz
    ▼
FastAPI /ws/session  ──proxy──►  wss://api.x.ai/v1/realtime
    │
    ├─ function tools (lookup_order) resolved in browser → function_call_output
    └─ web_search executed server-side by xAI
```

## Security

- Never commit `.env`.
- Demo audio is synthetic tones, not production Grok audio.
- Prefer [ephemeral tokens](https://docs.x.ai/developers/model-capabilities/audio/ephemeral-tokens) for browser-direct production clients.

## Stack

FastAPI · Uvicorn · websockets · AudioWorklet · vanilla HTML/CSS/JS · Docker

## Links

- Announcement: https://x.ai/news/grok-voice-think-fast-2  
- Docs: https://docs.x.ai/developers/model-capabilities/audio/voice-agent  
- Benchmarks: https://artificialanalysis.ai/speech-to-speech  

## License

MIT
