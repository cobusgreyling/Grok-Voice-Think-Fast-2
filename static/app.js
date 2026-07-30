/* global AudioContext */

const $ = (id) => document.getElementById(id);

const speakBtn = $("speakBtn");
const stopBtn = $("stopBtn");
const promptEl = $("prompt");
const voiceEl = $("voice");
const reasoningEl = $("reasoning");
const transcriptEl = $("transcript");
const statusEl = $("status");
const examplesEl = $("examples");
const modelName = $("modelName");
const keyStatus = $("keyStatus");
const mFirst = $("mFirst");
const mDone = $("mDone");
const mDur = $("mDur");

let audioCtx = null;
let currentSource = null;

function setStatus(msg, kind = "") {
  statusEl.textContent = msg || "";
  statusEl.className = "status" + (kind ? ` ${kind}` : "");
}

function fmtSec(v) {
  if (v == null || Number.isNaN(v)) return "—";
  return `${Number(v).toFixed(2)}s`;
}

async function loadHealth() {
  try {
    const res = await fetch("/api/health");
    const data = await res.json();
    modelName.textContent = data.model || "unknown";
    if (data.key_configured) {
      keyStatus.textContent = "API key configured";
      keyStatus.classList.add("ok");
    } else {
      keyStatus.textContent = "XAI_API_KEY missing";
      keyStatus.classList.add("bad");
    }
  } catch (err) {
    modelName.textContent = "offline";
    keyStatus.textContent = "health check failed";
    keyStatus.classList.add("bad");
  }
}

async function loadExamples() {
  try {
    const res = await fetch("/api/examples");
    const data = await res.json();
    (data.examples || []).forEach((ex) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "chip";
      btn.textContent = ex.label;
      btn.addEventListener("click", () => {
        promptEl.value = ex.text;
      });
      examplesEl.appendChild(btn);
    });
  } catch {
    /* optional */
  }
}

function stopAudio() {
  if (currentSource) {
    try {
      currentSource.stop();
    } catch {
      /* already stopped */
    }
    currentSource = null;
  }
  stopBtn.disabled = true;
}

function playPcmBase64(b64, sampleRate) {
  stopAudio();
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  const pcm16 = new Int16Array(bytes.buffer);
  const float32 = new Float32Array(pcm16.length);
  for (let i = 0; i < pcm16.length; i += 1) float32[i] = pcm16[i] / 32768;

  if (!audioCtx) audioCtx = new AudioContext({ sampleRate });
  const buffer = audioCtx.createBuffer(1, float32.length, sampleRate);
  buffer.copyToChannel(float32, 0);
  const source = audioCtx.createBufferSource();
  source.buffer = buffer;
  source.connect(audioCtx.destination);
  source.onended = () => {
    currentSource = null;
    stopBtn.disabled = true;
  };
  currentSource = source;
  stopBtn.disabled = false;
  source.start();
}

async function speak() {
  const text = promptEl.value.trim();
  if (!text) {
    setStatus("Enter a prompt first.", "error");
    return;
  }

  speakBtn.disabled = true;
  setStatus("Connecting to Grok Voice Realtime…");
  transcriptEl.textContent = "…";
  mFirst.textContent = "…";
  mDone.textContent = "…";
  mDur.textContent = "…";

  try {
    const res = await fetch("/api/speak", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        voice: voiceEl.value,
        reasoning_effort: reasoningEl.value,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      const detail = typeof data.detail === "string" ? data.detail : JSON.stringify(data.detail);
      throw new Error(detail || res.statusText);
    }

    transcriptEl.textContent = data.transcript || "(no transcript deltas returned)";
    mFirst.textContent = fmtSec(data.metrics?.connect_to_first_audio_s);
    mDone.textContent = fmtSec(data.metrics?.connect_to_done_s);
    mDur.textContent = fmtSec(data.duration_s);
    setStatus(
      `Played ${data.audio_bytes.toLocaleString()} bytes · ${data.model} · voice=${data.voice}`,
      "ok",
    );
    playPcmBase64(data.audio_base64, data.sample_rate || 24000);
  } catch (err) {
    transcriptEl.textContent = "Request failed.";
    setStatus(err.message || String(err), "error");
    mFirst.textContent = "—";
    mDone.textContent = "—";
    mDur.textContent = "—";
  } finally {
    speakBtn.disabled = false;
  }
}

speakBtn.addEventListener("click", speak);
stopBtn.addEventListener("click", stopAudio);

loadHealth();
loadExamples();
