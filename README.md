# Grok Voice Think Fast 2.0

Article + hands-on latency playground for **xAI Grok Voice Think Fast 2.0** — the flagship speech-to-speech model that reasons while it speaks.

![Header](assets/header.jpg)

**Article:** [`BLOG.md`](BLOG.md)  
**Announcement:** [x.ai/news/grok-voice-think-fast-2](https://x.ai/news/grok-voice-think-fast-2)

## What this repo shows

- Why 2.0 matters (intelligence, transcription, reasoning efficiency, conversation)
- Artificial Analysis headline numbers (index, dynamics, 𝜏-Voice, **0.70s** first audio)
- A local **text → speech** demo against `grok-voice-think-fast-2.0`
- First-audio latency measurement you can re-run while drafting the article

## Prerequisites

- Python 3.10+
- An xAI API key with Voice / Realtime access from [console.x.ai](https://console.x.ai/)

## Quick start

```bash
cd demos/grok-voice-think-fast-2   # or repo root if this is the standalone clone

python3 -m venv .venv
source .venv/bin/activate         # Windows: .venv\Scripts\activate

pip install -r requirements.txt

cp .env.example .env
# set XAI_API_KEY=xai-...

python app.py
# or: ./run.sh
```

Open **http://127.0.0.1:7861**

## Environment

| Variable | Default | Description |
|----------|---------|-------------|
| `XAI_API_KEY` | _(required)_ | xAI API key |
| `XAI_VOICE_MODEL` | `grok-voice-think-fast-2.0` | Realtime model id |
| `XAI_VOICE` | `eve` | Default voice (`eve`, `ara`, `rex`, `sal`, `leo`) |
| `HOST` | `127.0.0.1` | Bind address |
| `PORT` | `7861` | HTTP port |

## Demo flow

1. Confirm the badge shows **API key configured**
2. Pick a voice + reasoning effort (`high` / `none`)
3. Click an example chip or type a multi-step prompt
4. Hit **Speak** — the server opens a Realtime session, sends your text turn, streams PCM back
5. Read **Connect → first audio** (includes network + cold session setup; not identical to Artificial Analysis lab TTFA)

## API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | Demo UI |
| `GET` | `/api/health` | Key / model status |
| `GET` | `/api/examples` | Sample prompts |
| `POST` | `/api/speak` | `{ "text", "voice?", "reasoning_effort?" }` → audio + metrics |
| `WS` | `/ws/proxy` | Optional raw proxy to `wss://api.x.ai/v1/realtime` |

## Security

- Never commit `.env` or paste live keys into screenshots of the repo.
- Prefer **ephemeral tokens** for any browser-direct production client (this demo keeps the key on the server).
- Rotate any key that was shared in chat.

## Stack

- FastAPI + Uvicorn
- `websockets` client → xAI Realtime Speech-to-Speech API
- Vanilla HTML/CSS/JS UI

## Related

- Docs: [Speech to Speech](https://docs.x.ai/developers/model-capabilities/audio/voice-agent)
- Voice Agent Builder: [x.ai/voice](https://x.ai/voice)
- Benchmarks: [Artificial Analysis](https://artificialanalysis.ai/speech-to-speech)

## License

MIT — see companion article for attribution of xAI product claims and benchmark figures.
