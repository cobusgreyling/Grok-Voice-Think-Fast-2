/* global AudioContext, webkitAudioContext */

const SAMPLE_RATE = 24000;

const $ = (id) => document.getElementById(id);

const els = {
  modelName: $("modelName"),
  keyStatus: $("keyStatus"),
  connStatus: $("connStatus"),
  turnStatus: $("turnStatus"),
  connectBtn: $("connectBtn"),
  demoBtn: $("demoBtn"),
  compareBtn: $("compareBtn"),
  pttBtn: $("pttBtn"),
  micBtn: $("micBtn"),
  interruptBtn: $("interruptBtn"),
  exportBtn: $("exportBtn"),
  clearBtn: $("clearBtn"),
  sendBtn: $("sendBtn"),
  stopAudioBtn: $("stopAudioBtn"),
  applySessionBtn: $("applySessionBtn"),
  prompt: $("prompt"),
  voice: $("voice"),
  reasoning: $("reasoning"),
  micMode: $("micMode"),
  toolLookup: $("toolLookup"),
  toolWeb: $("toolWeb"),
  instructions: $("instructions"),
  examples: $("examples"),
  scenarios: $("scenarios"),
  chat: $("chat"),
  status: $("status"),
  eventLog: $("eventLog"),
  toggleLogBtn: $("toggleLogBtn"),
  liveDot: $("liveDot"),
  demoDot: $("demoDot"),
  stageHint: $("stageHint"),
  orb: $("orb"),
  orbCore: $("orbCore"),
  wave: $("wave"),
  spark: $("spark"),
  mFirst: $("mFirst"),
  mDone: $("mDone"),
  mTurns: $("mTurns"),
  mAvg: $("mAvg"),
  errorBanner: $("errorBanner"),
  errorTitle: $("errorTitle"),
  errorMessage: $("errorMessage"),
  errorFix: $("errorFix"),
  errorDemoBtn: $("errorDemoBtn"),
  errorDismissBtn: $("errorDismissBtn"),
  comparePanel: $("comparePanel"),
  compareNote: $("compareNote"),
  compareDelta: $("compareDelta"),
  cmpHighFirst: $("cmpHighFirst"),
  cmpNoneFirst: $("cmpNoneFirst"),
  cmpHighText: $("cmpHighText"),
  cmpNoneText: $("cmpNoneText"),
  cmpPlayHigh: $("cmpPlayHigh"),
  cmpPlayNone: $("cmpPlayNone"),
  pttHint: $("pttHint"),
};

/** @type {WebSocket | null} */
let ws = null;
/** @type {AudioContext | null} */
let audioCtx = null;
/** @type {MediaStream | null} */
let micStream = null;
/** @type {MediaStreamAudioSourceNode | null} */
let micSource = null;
/** @type {AudioWorkletNode | null} */
let workletNode = null;
/** @type {GainNode | null} */
let micMute = null;
let workletReady = false;
let micArmed = false; // hardware mic open (stream + worklet)
let micSending = false; // currently appending PCM (PTT held or open-mic on)
let pttHeld = false;
let connected = false;
let demoMode = false;
let speaking = false;
let awaitingResponse = false;
let turnStartMs = null;
let firstAudioMs = null;
let turnCount = 0;
let keyConfigured = false;
const latencyHistory = [];
/** @type {any} */
let demoBundle = null;
/** @type {any} */
let lastCompare = null;

/** @type {{ts:string, role:string, text:string, meta?:string, kind?:string}[]} */
const transcriptLog = [];
/** @type {{ts:string, first_audio_s:number|null, done_s?:number|null, source?:string}[]} */
const latencyLog = [];
/** @type {{ts:string, name:string, arguments:any, result?:any}[]} */
const toolLog = [];
/** @type {string[]} */
const eventLogLines = [];

let nextPlayTime = 0;
/** @type {AudioBufferSourceNode[]} */
const activeSources = [];
/** pending function calls waiting for playback before response.create */
const pendingFunctionResults = [];
let functionCallsInFlight = 0;

let partialAssistantEl = null;
let partialUserEl = null;
let partialAssistantText = "";
let partialUserText = "";

const waveCtx = els.wave.getContext("2d");
const sparkCtx = els.spark.getContext("2d");
const waveLevels = new Float32Array(64);
let waveWrite = 0;

const FAKE_ORDERS = {
  "88421": {
    order_id: "88421",
    status: "in_transit",
    carrier: "NovaShip Express",
    eta: "2026-08-02",
    last_scan: "Johannesburg hub",
    recipient: "Greyling",
  },
  "4491": {
    order_id: "NS-4491",
    status: "delivered",
    carrier: "NovaShip",
    eta: "2026-07-28",
    last_scan: "Cape Town depot",
    recipient: "Greyling",
  },
};

// ---------------------------------------------------------------------------
// Friendly errors
// ---------------------------------------------------------------------------

function showFriendlyError(err) {
  const parsed = normalizeError(err);
  els.errorBanner.hidden = false;
  els.errorTitle.textContent = parsed.title;
  els.errorMessage.textContent = parsed.message;
  els.errorFix.textContent = parsed.fix || "";
  els.errorFix.hidden = !parsed.fix;
  setStatus(`${parsed.title}: ${parsed.message}`, "error");
  logEvent(`error ${parsed.code || "?"} — ${parsed.message}`);
}

function hideFriendlyError() {
  els.errorBanner.hidden = true;
}

function normalizeError(err) {
  if (!err) {
    return {
      code: "generic",
      title: "Something went wrong",
      message: "Unknown error",
      fix: "Try Demo mode, then retry.",
    };
  }
  if (typeof err === "string") return classifyClientString(err);
  const detail = err.detail ?? err.error ?? err;
  if (typeof detail === "string") return classifyClientString(detail);
  if (detail && typeof detail === "object" && (detail.title || detail.message || detail.code)) {
    return {
      code: detail.code || "generic",
      title: detail.title || "Error",
      message: detail.message || detail.raw || JSON.stringify(detail),
      fix: detail.fix || "",
    };
  }
  if (err.message) return classifyClientString(err.message);
  return {
    code: "generic",
    title: "Something went wrong",
    message: JSON.stringify(err).slice(0, 300),
    fix: "Try Demo mode, then retry.",
  };
}

function classifyClientString(text) {
  const low = String(text).toLowerCase();
  if (low.includes("xai_api_key") || low.includes("not configured") || low.includes("missing_key")) {
    return {
      code: "missing_key",
      title: "API key not configured",
      message: "No XAI_API_KEY on the server. Use Demo mode without a key, or add one.",
      fix: "cp .env.example .env  # then set XAI_API_KEY=xai-… from console.x.ai",
    };
  }
  if (low.includes("notallowederror") || low.includes("permission denied") || low.includes("microphone")) {
    return {
      code: "mic_denied",
      title: "Microphone blocked",
      message: "The browser denied mic access.",
      fix: "Allow microphone for this site, or use text chat / Demo mode.",
    };
  }
  if (low.includes("failed to fetch") || low.includes("networkerror")) {
    return {
      code: "network",
      title: "Could not reach the lab server",
      message: "Is the server running on port 7861?",
      fix: "python app.py   # or: docker compose up --build",
    };
  }
  return {
    code: "generic",
    title: "Something went wrong",
    message: String(text),
    fix: "Try Demo mode to confirm the UI, then retry with a key.",
  };
}

async function readErrorBody(res) {
  try {
    return await res.json();
  } catch {
    return { detail: res.statusText || `HTTP ${res.status}` };
  }
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

function setStatus(msg, kind = "") {
  els.status.textContent = msg || "";
  els.status.className = "status" + (kind ? ` ${kind}` : "");
}

function setConn(state) {
  els.connStatus.textContent = state;
  els.connStatus.classList.remove("ok", "bad", "live", "warn");
  if (state === "connected") els.connStatus.classList.add("live");
  else if (state === "demo" || state === "connecting") els.connStatus.classList.add("warn");
  else if (state === "error") els.connStatus.classList.add("bad");
}

function setTurn(state) {
  els.turnStatus.textContent = state;
  els.orb.classList.remove("listening", "speaking", "thinking");
  if (state === "listening") {
    els.orb.classList.add("listening");
    els.orbCore.textContent = "🎙";
  } else if (state === "speaking") {
    els.orb.classList.add("speaking");
    els.orbCore.textContent = "◉";
  } else if (state === "thinking") {
    els.orb.classList.add("thinking");
    els.orbCore.textContent = "…";
  } else {
    els.orbCore.textContent = connected || demoMode ? "●" : "○";
  }
}

function logEvent(line) {
  const ts = new Date().toLocaleTimeString();
  const entry = `[${ts}] ${line}`;
  eventLogLines.unshift(entry);
  if (eventLogLines.length > 200) eventLogLines.length = 200;
  els.eventLog.textContent = eventLogLines.join("\n").slice(0, 8000);
}

function fmtSec(v) {
  if (v == null || Number.isNaN(v)) return "—";
  return `${Number(v).toFixed(2)}s`;
}

function nowIso() {
  return new Date().toISOString();
}

function ensureAudioCtx() {
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    audioCtx = new AC({ sampleRate: SAMPLE_RATE });
  }
  if (audioCtx.state === "suspended") audioCtx.resume();
  return audioCtx;
}

function isTypingTarget(el) {
  if (!el) return false;
  const tag = (el.tagName || "").toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || el.isContentEditable;
}

function setLiveUi(isOn) {
  connected = isOn;
  if (isOn) demoMode = false;
  els.liveDot.hidden = !isOn;
  if (isOn) els.demoDot.hidden = true;
  els.connectBtn.textContent = isOn ? "Disconnect" : "Connect";
  els.sendBtn.disabled = !(isOn || demoMode);
  els.pttBtn.disabled = !isOn;
  els.micBtn.disabled = !isOn;
  els.interruptBtn.disabled = !isOn;
  els.clearBtn.disabled = !(isOn || demoMode);
  els.exportBtn.disabled = transcriptLog.length === 0 && latencyLog.length === 0;
  els.applySessionBtn.disabled = !isOn;
  els.demoBtn.disabled = isOn;
  updateMicModeUi();
  if (isOn) {
    setConn("connected");
    setTurn(micSending ? "listening" : "idle");
    els.stageHint.textContent =
      els.micMode.value === "ptt"
        ? "Live — hold Space / Hold to talk, or type a message."
        : "Live — Open mic streams with server VAD.";
  } else if (!demoMode) {
    setConn("disconnected");
    setTurn("idle");
    els.stageHint.textContent = keyConfigured
      ? "Connect with your key, or start Demo mode offline."
      : "No API key detected — start Demo mode, or add XAI_API_KEY.";
  }
}

function setDemoUi(isOn) {
  demoMode = isOn;
  if (isOn) {
    connected = false;
    els.liveDot.hidden = true;
    els.demoDot.hidden = false;
    els.connectBtn.textContent = "Connect";
    els.sendBtn.disabled = false;
    els.clearBtn.disabled = false;
    els.exportBtn.disabled = false;
    els.pttBtn.disabled = true;
    els.micBtn.disabled = true;
    els.interruptBtn.disabled = true;
    els.applySessionBtn.disabled = true;
    els.demoBtn.textContent = "■ Stop demo";
    setConn("demo");
    setTurn("idle");
    els.stageHint.textContent = "Demo mode — replaying recorded turns (no API key).";
  } else {
    els.demoDot.hidden = true;
    els.demoBtn.textContent = "▶ Demo mode";
    els.sendBtn.disabled = !connected;
    els.clearBtn.disabled = !connected;
    if (!connected) {
      setConn("disconnected");
      setTurn("idle");
    }
  }
}

function updateMicModeUi() {
  const ptt = els.micMode.value === "ptt";
  els.pttBtn.style.display = connected && ptt ? "" : connected ? "none" : "";
  els.micBtn.style.display = connected && !ptt ? "" : connected ? "none" : "";
  if (!connected) {
    els.pttBtn.style.display = "";
    els.micBtn.style.display = "";
  }
  els.pttHint.textContent = ptt
    ? "Push-to-talk: hold Space or the button (best for noisy rooms / demos)."
    : "Open mic: continuous capture + server VAD auto turn-taking.";
}

// ---------------------------------------------------------------------------
// Waveform + sparkline
// ---------------------------------------------------------------------------

function pushWaveLevel(level) {
  waveLevels[waveWrite % waveLevels.length] = level;
  waveWrite += 1;
}

function drawWave() {
  const w = els.wave.width;
  const h = els.wave.height;
  waveCtx.clearRect(0, 0, w, h);
  waveCtx.fillStyle = "#0b0d13";
  waveCtx.fillRect(0, 0, w, h);
  const n = waveLevels.length;
  const barW = w / n;
  for (let i = 0; i < n; i += 1) {
    const idx = (waveWrite + i) % n;
    const v = waveLevels[idx] || 0;
    const barH = Math.max(2, v * (h - 8));
    const x = i * barW;
    const y = (h - barH) / 2;
    waveCtx.fillStyle = speaking
      ? `rgba(56, 189, 248, ${0.35 + v * 0.65})`
      : micSending
        ? `rgba(52, 211, 153, ${0.35 + v * 0.65})`
        : `rgba(167, 139, 250, ${0.25 + v * 0.5})`;
    waveCtx.fillRect(x + 1, y, Math.max(1, barW - 2), barH);
  }
  requestAnimationFrame(drawWave);
}

function recordLatency(sec, extra = {}) {
  if (sec == null || Number.isNaN(sec)) return;
  latencyHistory.push(sec);
  if (latencyHistory.length > 24) latencyHistory.shift();
  latencyLog.push({
    ts: nowIso(),
    first_audio_s: sec,
    done_s: extra.done_s ?? null,
    source: extra.source || (demoMode ? "demo" : "live"),
  });
  const avg = latencyHistory.reduce((a, b) => a + b, 0) / latencyHistory.length;
  els.mAvg.textContent = fmtSec(avg);
  els.exportBtn.disabled = false;
  drawSpark();
}

function drawSpark() {
  const w = els.spark.width;
  const h = els.spark.height;
  sparkCtx.clearRect(0, 0, w, h);
  sparkCtx.fillStyle = "#0b0d13";
  sparkCtx.fillRect(0, 0, w, h);
  if (latencyHistory.length === 0) {
    sparkCtx.fillStyle = "#9aa3b5";
    sparkCtx.font = "11px sans-serif";
    sparkCtx.fillText("Latency history appears after turns", 10, h / 2 + 4);
    return;
  }
  const max = Math.max(1, ...latencyHistory, 1.5);
  const pad = 6;
  sparkCtx.strokeStyle = "rgba(56, 189, 248, 0.9)";
  sparkCtx.lineWidth = 2;
  sparkCtx.beginPath();
  latencyHistory.forEach((v, i) => {
    const x = pad + (i / Math.max(1, latencyHistory.length - 1)) * (w - pad * 2);
    const y = h - pad - (v / max) * (h - pad * 2);
    if (i === 0) sparkCtx.moveTo(x, y);
    else sparkCtx.lineTo(x, y);
  });
  sparkCtx.stroke();
  const yRef = h - pad - (0.7 / max) * (h - pad * 2);
  sparkCtx.strokeStyle = "rgba(167, 139, 250, 0.45)";
  sparkCtx.setLineDash([4, 4]);
  sparkCtx.beginPath();
  sparkCtx.moveTo(pad, yRef);
  sparkCtx.lineTo(w - pad, yRef);
  sparkCtx.stroke();
  sparkCtx.setLineDash([]);
  sparkCtx.fillStyle = "rgba(167, 139, 250, 0.8)";
  sparkCtx.font = "10px sans-serif";
  sparkCtx.fillText("0.70s lab", w - 58, Math.max(12, yRef - 4));
}

// ---------------------------------------------------------------------------
// Chat + tool chips + export
// ---------------------------------------------------------------------------

function ensureEmptyChatHint() {
  if (!els.chat.children.length) {
    const empty = document.createElement("div");
    empty.className = "empty-chat";
    empty.id = "emptyChat";
    empty.textContent = keyConfigured
      ? "No turns yet. Connect, Demo mode, Compare, or Hold to talk."
      : "No API key — click Demo mode, or add XAI_API_KEY for live voice.";
    els.chat.appendChild(empty);
  }
}

function clearEmptyHint() {
  const empty = $("emptyChat");
  if (empty) empty.remove();
}

function addMessage(role, text, meta = "", kind = "message") {
  clearEmptyHint();
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  const roleEl = document.createElement("span");
  roleEl.className = "role";
  roleEl.textContent = role === "user" ? "You" : "Grok Voice";
  div.appendChild(roleEl);
  const body = document.createElement("div");
  body.className = "body";
  body.textContent = text;
  div.appendChild(body);
  if (meta) {
    const m = document.createElement("span");
    m.className = "meta";
    m.textContent = meta;
    div.appendChild(m);
  }
  els.chat.appendChild(div);
  els.chat.scrollTop = els.chat.scrollHeight;
  transcriptLog.push({ ts: nowIso(), role, text, meta, kind });
  els.exportBtn.disabled = false;
  return div;
}

function addToolChip(name, args, result) {
  clearEmptyHint();
  const div = document.createElement("div");
  div.className = "msg tool";
  const roleEl = document.createElement("span");
  roleEl.className = "role";
  roleEl.textContent = "Tool call";
  div.appendChild(roleEl);

  const chip = document.createElement("div");
  chip.className = "tool-chip";
  chip.innerHTML = `<span class="tool-name">⚙ ${escapeHtml(name)}</span>`;
  div.appendChild(chip);

  const body = document.createElement("div");
  body.className = "body tool-body";
  body.textContent = `args: ${JSON.stringify(args)}\n→ ${JSON.stringify(result)}`;
  div.appendChild(body);

  els.chat.appendChild(div);
  els.chat.scrollTop = els.chat.scrollHeight;
  transcriptLog.push({
    ts: nowIso(),
    role: "tool",
    text: `${name}(${JSON.stringify(args)}) → ${JSON.stringify(result)}`,
    kind: "tool",
  });
  toolLog.push({ ts: nowIso(), name, arguments: args, result });
  els.exportBtn.disabled = false;
  logEvent(`tool ${name}`);
  return div;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function beginPartial(role) {
  clearEmptyHint();
  const div = document.createElement("div");
  div.className = `msg ${role} partial`;
  const roleEl = document.createElement("span");
  roleEl.className = "role";
  roleEl.textContent = role === "user" ? "You (listening…)" : "Grok Voice (speaking…)";
  div.appendChild(roleEl);
  const body = document.createElement("div");
  body.className = "body";
  body.textContent = "";
  div.appendChild(body);
  els.chat.appendChild(div);
  els.chat.scrollTop = els.chat.scrollHeight;
  return div;
}

function finalizePartial(el, finalText, meta = "") {
  if (!el) return;
  el.classList.remove("partial");
  el.querySelector(".role").textContent = el.classList.contains("user") ? "You" : "Grok Voice";
  el.querySelector(".body").textContent = finalText || "(empty)";
  if (meta) {
    let m = el.querySelector(".meta");
    if (!m) {
      m = document.createElement("span");
      m.className = "meta";
      el.appendChild(m);
    }
    m.textContent = meta;
  }
  transcriptLog.push({
    ts: nowIso(),
    role: el.classList.contains("user") ? "user" : "assistant",
    text: finalText || "",
    meta,
    kind: "message",
  });
  els.exportBtn.disabled = false;
  els.chat.scrollTop = els.chat.scrollHeight;
}

function clearChat() {
  els.chat.innerHTML = "";
  transcriptLog.length = 0;
  ensureEmptyChatHint();
  partialAssistantEl = null;
  partialUserEl = null;
  partialAssistantText = "";
  partialUserText = "";
  els.exportBtn.disabled = latencyLog.length === 0;
}

function exportSession() {
  const payload = {
    exported_at: nowIso(),
    model: els.modelName.textContent,
    mode: demoMode ? "demo" : connected ? "live" : "idle",
    voice: els.voice.value,
    reasoning: els.reasoning.value,
    mic_mode: els.micMode.value,
    tools_enabled: {
      lookup_order: els.toolLookup.checked,
      web_search: els.toolWeb.checked,
    },
    metrics_summary: {
      turns: turnCount,
      avg_first_audio_s:
        latencyHistory.length > 0
          ? Number(
              (
                latencyHistory.reduce((a, b) => a + b, 0) / latencyHistory.length
              ).toFixed(3),
            )
          : null,
      lab_reference_first_audio_s: 0.7,
    },
    transcript: transcriptLog,
    latency: latencyLog,
    tools: toolLog,
    events_tail: eventLogLines.slice(0, 80),
    compare: lastCompare
      ? {
          source: lastCompare.source,
          prompt: lastCompare.prompt,
          high: {
            first_audio_s: lastCompare.high?.metrics?.first_audio_s,
            transcript: lastCompare.high?.transcript,
          },
          none: {
            first_audio_s: lastCompare.none?.metrics?.first_audio_s,
            transcript: lastCompare.none?.transcript,
          },
          delta_first_audio_s: lastCompare.delta_first_audio_s,
        }
      : null,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  a.href = URL.createObjectURL(blob);
  a.download = `grok-voice-session-${stamp}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  setStatus(`Exported ${a.download}`, "ok");
  logEvent("session exported");
}

// ---------------------------------------------------------------------------
// Audio playback
// ---------------------------------------------------------------------------

function stopPlayback() {
  activeSources.forEach((s) => {
    try {
      s.stop();
    } catch {
      /* */
    }
  });
  activeSources.length = 0;
  nextPlayTime = 0;
  speaking = false;
  els.stopAudioBtn.disabled = true;
  if ((connected || demoMode) && !awaitingResponse) {
    setTurn(micSending ? "listening" : "idle");
  }
}

function playPcmChunk(int16) {
  const ctx = ensureAudioCtx();
  const float32 = new Float32Array(int16.length);
  let peak = 0;
  for (let i = 0; i < int16.length; i += 1) {
    const v = int16[i] / 32768;
    float32[i] = v;
    peak = Math.max(peak, Math.abs(v));
  }
  pushWaveLevel(Math.min(1, peak * 3));
  const buffer = ctx.createBuffer(1, float32.length, SAMPLE_RATE);
  buffer.copyToChannel(float32, 0);
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);
  const now = ctx.currentTime;
  if (nextPlayTime < now + 0.02) nextPlayTime = now + 0.02;
  source.start(nextPlayTime);
  nextPlayTime += buffer.duration;
  activeSources.push(source);
  els.stopAudioBtn.disabled = false;
  speaking = true;
  setTurn("speaking");
  source.onended = () => {
    const idx = activeSources.indexOf(source);
    if (idx >= 0) activeSources.splice(idx, 1);
    if (!activeSources.length && !awaitingResponse) {
      speaking = false;
      els.stopAudioBtn.disabled = true;
      if (connected || demoMode) setTurn(micSending ? "listening" : "idle");
      maybeFlushFunctionResults();
    }
  };
}

function base64ToInt16(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Int16Array(bytes.buffer);
}

function playBase64Pcm(b64) {
  stopPlayback();
  playPcmChunk(base64ToInt16(b64));
}

function int16ToBase64(int16) {
  const bytes = new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// ---------------------------------------------------------------------------
// AudioWorklet mic + PTT
// ---------------------------------------------------------------------------

async function ensureWorklet() {
  const ctx = ensureAudioCtx();
  if (workletReady) return ctx;
  await ctx.audioWorklet.addModule("/static/pcm-worklet.js");
  workletReady = true;
  return ctx;
}

async function armMicHardware() {
  if (micArmed) return;
  const ctx = await ensureWorklet();
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  } catch (err) {
    showFriendlyError(err);
    throw err;
  }
  micSource = ctx.createMediaStreamSource(micStream);
  workletNode = new AudioWorkletNode(ctx, "pcm-capture", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    channelCount: 1,
    processorOptions: { targetRate: SAMPLE_RATE, frameSamples: 480 },
  });
  workletNode.port.onmessage = (ev) => {
    if (!ev.data || ev.data.type !== "pcm") return;
    if (!micSending || !ws || ws.readyState !== WebSocket.OPEN) return;
    const pcm = new Int16Array(ev.data.pcm);
    pushWaveLevel(Math.min(1, (ev.data.peak || 0) * 2.2));
    sendEvent({ type: "input_audio_buffer.append", audio: int16ToBase64(pcm) });
  };
  micMute = ctx.createGain();
  micMute.gain.value = 0;
  micSource.connect(workletNode);
  workletNode.connect(micMute);
  micMute.connect(ctx.destination);
  micArmed = true;
  setMicSending(false);
  logEvent("mic hardware armed (AudioWorklet)");
}

function setMicSending(on) {
  micSending = on;
  if (workletNode) {
    workletNode.port.postMessage({ type: "set-enabled", enabled: on });
  }
  if (on) {
    els.pttBtn.classList.add("active-mic");
    els.micBtn.classList.add("active-mic");
    setTurn(speaking ? "speaking" : "listening");
  } else {
    els.pttBtn.classList.remove("active-mic");
    if (els.micMode.value === "ptt") els.micBtn.classList.remove("active-mic");
    if (!speaking && !awaitingResponse) setTurn("idle");
  }
}

async function disarmMicHardware() {
  setMicSending(false);
  pttHeld = false;
  if (workletNode) {
    try {
      workletNode.disconnect();
    } catch {
      /* */
    }
    workletNode.port.onmessage = null;
    workletNode = null;
  }
  if (micMute) {
    try {
      micMute.disconnect();
    } catch {
      /* */
    }
    micMute = null;
  }
  if (micSource) {
    try {
      micSource.disconnect();
    } catch {
      /* */
    }
    micSource = null;
  }
  if (micStream) {
    micStream.getTracks().forEach((t) => t.stop());
    micStream = null;
  }
  micArmed = false;
  els.micBtn.classList.remove("active-mic");
  els.pttBtn.classList.remove("active-mic");
  els.micBtn.textContent = "🎙 Open mic";
  logEvent("mic disarmed");
}

async function pttDown() {
  if (!connected || els.micMode.value !== "ptt") return;
  if (pttHeld) return;
  pttHeld = true;
  hideFriendlyError();
  try {
    await armMicHardware();
  } catch {
    pttHeld = false;
    return;
  }
  // Clear any leftover buffer from previous hold
  sendEvent({ type: "input_audio_buffer.clear" });
  setMicSending(true);
  stopPlayback(); // barge-in
  setStatus("Listening… release to send.", "ok");
  logEvent("ptt down");
}

function pttUp() {
  if (!pttHeld) return;
  pttHeld = false;
  setMicSending(false);
  if (!connected || !ws || ws.readyState !== WebSocket.OPEN) return;
  // Commit + create response (manual turn detection)
  sendEvent({ type: "input_audio_buffer.commit" });
  sendEvent({ type: "response.create" });
  markTurnStart();
  if (!partialAssistantEl) {
    partialAssistantEl = beginPartial("assistant");
    partialAssistantText = "";
  }
  setStatus("Processing turn…", "ok");
  logEvent("ptt up → commit + response.create");
}

async function toggleOpenMic() {
  if (!connected || els.micMode.value !== "open") return;
  if (micSending && micArmed) {
    await disarmMicHardware();
    setStatus("Open mic off.", "ok");
    return;
  }
  try {
    await armMicHardware();
    setMicSending(true);
    els.micBtn.textContent = "🎙 Mic on";
    setStatus("Open mic live — server VAD detects turns.", "ok");
    logEvent("open mic on");
  } catch {
    /* friendly error already shown */
  }
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

function buildTools() {
  const tools = [];
  if (els.toolLookup.checked) {
    tools.push({
      type: "function",
      name: "lookup_order",
      description:
        "Look up a shipping order by order id (and optional last name). Use before answering order questions.",
      parameters: {
        type: "object",
        properties: {
          order_id: { type: "string", description: "Order id, e.g. 88421" },
          last_name: { type: "string", description: "Customer last name if known" },
        },
        required: ["order_id"],
      },
    });
  }
  if (els.toolWeb.checked) {
    tools.push({ type: "web_search" });
  }
  return tools;
}

function executeLookupOrder(args) {
  const id = String(args.order_id || args.orderId || "").replace(/\D/g, "");
  const hit =
    FAKE_ORDERS[id] ||
    FAKE_ORDERS[String(args.order_id || "")] ||
    {
      order_id: args.order_id,
      status: "not_found",
      message: "No matching order in demo CRM. Try 88421 or 4491.",
    };
  return hit;
}

function handleFunctionCall(event) {
  const name = event.name;
  const callId = event.call_id;
  let args = {};
  try {
    args = JSON.parse(event.arguments || "{}");
  } catch {
    args = { raw: event.arguments };
  }

  let result;
  if (name === "lookup_order") {
    result = executeLookupOrder(args);
  } else {
    result = { error: `Unknown local tool: ${name}` };
  }

  addToolChip(name, args, result);
  functionCallsInFlight += 1;
  pendingFunctionResults.push({ callId, result });
  // Send outputs immediately; wait for audio gap before response.create when possible
  sendEvent({
    type: "conversation.item.create",
    item: {
      type: "function_call_output",
      call_id: callId,
      output: JSON.stringify(result),
    },
  });
  functionCallsInFlight -= 1;
  maybeFlushFunctionResults();
}

function maybeFlushFunctionResults() {
  if (functionCallsInFlight > 0) return;
  if (!pendingFunctionResults.length) return;
  // If still speaking, wait for onended; else continue
  if (speaking && activeSources.length) return;
  pendingFunctionResults.length = 0;
  sendEvent({ type: "response.create" });
  logEvent("function results flushed → response.create");
  setTurn("thinking");
}

// ---------------------------------------------------------------------------
// Demo mode
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function ensureDemoBundle() {
  if (demoBundle) return demoBundle;
  const res = await fetch("/api/demo");
  if (!res.ok) {
    showFriendlyError(await readErrorBody(res));
    throw new Error("demo load failed");
  }
  demoBundle = await res.json();
  return demoBundle;
}

async function runDemoMode() {
  if (demoMode) {
    setDemoUi(false);
    stopPlayback();
    setStatus("Demo stopped.");
    return;
  }
  if (connected) disconnect();
  hideFriendlyError();
  try {
    const data = await ensureDemoBundle();
    setDemoUi(true);
    clearChat();
    setStatus(data.note || "Playing offline demo…", "ok");
    logEvent("demo mode start");

    for (const turn of data.turns || []) {
      if (!demoMode) return;
      addMessage("user", turn.user);
      if (turn.tool) {
        addToolChip(turn.tool.name, turn.tool.arguments, turn.tool.result);
        await sleep(400);
      }
      setTurn("thinking");
      await sleep(350);
      const partial = beginPartial("assistant");
      const words = (turn.assistant || "").split(/(\s+)/);
      let acc = "";
      for (const w of words) {
        if (!demoMode) return;
        acc += w;
        partial.querySelector(".body").textContent = acc;
        els.chat.scrollTop = els.chat.scrollHeight;
        await sleep(18);
      }
      const first = turn.metrics?.first_audio_s;
      const done = turn.metrics?.done_s;
      finalizePartial(partial, turn.assistant, `demo · first audio ${fmtSec(first)}`);
      els.mFirst.textContent = fmtSec(first);
      els.mDone.textContent = fmtSec(done);
      turnCount += 1;
      els.mTurns.textContent = String(turnCount);
      recordLatency(first, { done_s: done, source: "demo" });
      (turn.events || []).forEach((ev) => logEvent(ev));
      if (turn.audio_base64) {
        playBase64Pcm(turn.audio_base64);
        await sleep(Math.min(2200, (done || 1.5) * 900));
      }
      setTurn("idle");
      await sleep(400);
    }
    setStatus("Demo complete. Export JSON or Connect for live voice.", "ok");
  } catch (err) {
    setDemoUi(false);
    showFriendlyError(err);
  }
}

// ---------------------------------------------------------------------------
// Compare
// ---------------------------------------------------------------------------

async function runCompare() {
  hideFriendlyError();
  els.compareBtn.disabled = true;
  setStatus(keyConfigured ? "Comparing reasoning high vs none (live)…" : "Comparing offline demo A/B…");
  setTurn("thinking");
  logEvent("compare start");
  try {
    const text =
      els.prompt.value.trim() ||
      (demoBundle && demoBundle.compare_prompt) ||
      undefined;
    const res = await fetch("/api/compare", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        voice: els.voice.value,
        instructions: els.instructions.value,
        force_demo: !keyConfigured,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      showFriendlyError(data);
      return;
    }
    lastCompare = data;
    els.comparePanel.hidden = false;
    els.compareNote.textContent = `${data.source === "demo" ? "Offline demo" : "Live"} · ${data.prompt}`;
    els.cmpHighFirst.textContent = fmtSec(data.high?.metrics?.first_audio_s);
    els.cmpNoneFirst.textContent = fmtSec(data.none?.metrics?.first_audio_s);
    els.cmpHighText.textContent = data.high?.transcript || "";
    els.cmpNoneText.textContent = data.none?.transcript || "";
    if (data.delta_first_audio_s != null) {
      const d = data.delta_first_audio_s;
      els.compareDelta.textContent =
        d > 0
          ? `none was ${fmtSec(d)} faster to first audio than high on this run.`
          : d < 0
            ? `high was ${fmtSec(-d)} faster to first audio than none on this run.`
            : "Same first-audio latency on this run.";
    } else {
      els.compareDelta.textContent = data.note || "";
    }

    addMessage("user", data.prompt, "compare prompt");
    addMessage(
      "assistant",
      data.high?.transcript || "",
      `reasoning=high · first audio ${fmtSec(data.high?.metrics?.first_audio_s)} · ${data.source}`,
    );
    addMessage(
      "assistant",
      data.none?.transcript || "",
      `reasoning=none · first audio ${fmtSec(data.none?.metrics?.first_audio_s)} · ${data.source}`,
    );

    recordLatency(data.high?.metrics?.first_audio_s, { source: data.source });
    recordLatency(data.none?.metrics?.first_audio_s, { source: data.source });
    els.mFirst.textContent = fmtSec(data.none?.metrics?.first_audio_s);
    els.mDone.textContent = fmtSec(data.none?.metrics?.done_s);
    turnCount += 2;
    els.mTurns.textContent = String(turnCount);

    if (data.high?.audio_base64) {
      playBase64Pcm(data.high.audio_base64);
      await sleep(1600);
    }
    if (data.none?.audio_base64) playBase64Pcm(data.none.audio_base64);
    setStatus(`Compare done (${data.source}).`, "ok");
    logEvent(`compare done source=${data.source}`);
  } catch (err) {
    showFriendlyError(err);
  } finally {
    els.compareBtn.disabled = false;
    setTurn("idle");
  }
}

// ---------------------------------------------------------------------------
// Live WebSocket
// ---------------------------------------------------------------------------

function wsUrl() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws/session`;
}

function sendEvent(obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(obj));
}

function sessionUpdatePayload() {
  const ptt = els.micMode.value === "ptt";
  const session = {
    voice: els.voice.value,
    instructions: els.instructions.value.trim(),
    reasoning: { effort: els.reasoning.value },
    audio: {
      input: { format: { type: "audio/pcm", rate: SAMPLE_RATE } },
      output: { format: { type: "audio/pcm", rate: SAMPLE_RATE } },
    },
    tools: buildTools(),
  };
  if (ptt) {
    session.turn_detection = null;
  } else {
    session.turn_detection = {
      type: "server_vad",
      threshold: 0.85,
      silence_duration_ms: 600,
      prefix_padding_ms: 300,
    };
  }
  return { type: "session.update", session };
}

function markTurnStart() {
  turnStartMs = performance.now();
  firstAudioMs = null;
  awaitingResponse = true;
  setTurn("thinking");
}

function markFirstAudio() {
  if (firstAudioMs == null && turnStartMs != null) {
    firstAudioMs = performance.now();
    const sec = (firstAudioMs - turnStartMs) / 1000;
    els.mFirst.textContent = fmtSec(sec);
    recordLatency(sec, { source: "live" });
  }
  speaking = true;
  setTurn("speaking");
}

function markTurnDone() {
  let done = null;
  if (turnStartMs != null) {
    done = (performance.now() - turnStartMs) / 1000;
    els.mDone.textContent = fmtSec(done);
    if (latencyLog.length) latencyLog[latencyLog.length - 1].done_s = Number(done.toFixed(3));
    turnCount += 1;
    els.mTurns.textContent = String(turnCount);
  }
  awaitingResponse = false;
  if (partialAssistantEl) {
    const meta =
      firstAudioMs != null && turnStartMs != null
        ? `first audio ${fmtSec((firstAudioMs - turnStartMs) / 1000)}`
        : "";
    finalizePartial(partialAssistantEl, partialAssistantText, meta);
    partialAssistantEl = null;
    partialAssistantText = "";
  }
  if (!speaking) setTurn(micSending ? "listening" : "idle");
  turnStartMs = null;
  maybeFlushFunctionResults();
}

async function connect() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    disconnect();
    return;
  }
  if (!keyConfigured) {
    showFriendlyError({
      code: "missing_key",
      title: "API key not configured",
      message: "Live Connect needs XAI_API_KEY. Use Demo mode without a key.",
      fix: "cp .env.example .env  # then set XAI_API_KEY=xai-… from console.x.ai\n# or: docker compose up --build",
    });
    return;
  }
  if (demoMode) setDemoUi(false);
  hideFriendlyError();
  setConn("connecting");
  setStatus("Connecting to Realtime proxy…");
  logEvent("connecting…");
  ensureAudioCtx();

  ws = new WebSocket(wsUrl());
  ws.binaryType = "arraybuffer";

  ws.onopen = () => {
    setLiveUi(true);
    sendEvent(sessionUpdatePayload());
    logEvent("connected + session.update sent");
    setStatus(
      els.micMode.value === "ptt"
        ? "Connected. Hold Space to talk, or type a message."
        : "Connected. Open mic or type a message.",
      "ok",
    );
  };

  ws.onmessage = (ev) => {
    if (typeof ev.data !== "string") {
      markFirstAudio();
      playPcmChunk(new Int16Array(ev.data));
      return;
    }
    let event;
    try {
      event = JSON.parse(ev.data);
    } catch {
      logEvent(`non-json: ${String(ev.data).slice(0, 80)}`);
      return;
    }
    handleServerEvent(event);
  };

  ws.onerror = () => {
    setConn("error");
    showFriendlyError({
      code: "ws_closed",
      title: "WebSocket error",
      message: "Could not keep the live session open.",
      fix: "Confirm the server is running and XAI_API_KEY is valid, then Connect again.",
    });
  };

  ws.onclose = async () => {
    await disarmMicHardware();
    stopPlayback();
    setLiveUi(false);
    ws = null;
    logEvent("disconnected");
  };
}

async function disconnect() {
  await disarmMicHardware();
  stopPlayback();
  if (ws) {
    try {
      ws.close();
    } catch {
      /* */
    }
  }
  ws = null;
  setLiveUi(false);
}

function handleServerEvent(event) {
  const t = event.type || "unknown";
  if (!(t.includes("audio") && t.includes("delta"))) logEvent(t);

  if (t === "error" || event.error) {
    showFriendlyError(event.error || event);
    awaitingResponse = false;
    setTurn(micSending ? "listening" : "idle");
    return;
  }

  if (t === "session.updated" || t === "session.created") {
    setStatus("Session ready.", "ok");
    return;
  }

  if (t === "response.function_call_arguments.done") {
    handleFunctionCall(event);
    return;
  }

  // Server-side tools (web_search) may surface as item events — log chip when we see names
  if (t === "response.output_item.done" || t === "response.output_item.added") {
    const item = event.item || {};
    if (item.type === "function_call" || item.type === "web_search_call" || item.name) {
      const name = item.name || item.type || "tool";
      if (item.type && item.type !== "function_call") {
        addToolChip(name, item, { status: "server_side" });
      }
    }
  }

  if (
    t === "conversation.item.input_audio_transcription.delta" ||
    t === "conversation.item.input_audio_transcription.completed"
  ) {
    const piece = event.delta || event.transcript || "";
    if (t.endsWith("delta") && piece) {
      if (!partialUserEl) {
        partialUserEl = beginPartial("user");
        partialUserText = "";
      }
      partialUserText += piece;
      partialUserEl.querySelector(".body").textContent = partialUserText;
      els.chat.scrollTop = els.chat.scrollHeight;
    }
    if (t.endsWith("completed")) {
      const text = event.transcript || partialUserText;
      if (partialUserEl) {
        finalizePartial(partialUserEl, text);
        partialUserEl = null;
        partialUserText = "";
      } else if (text) addMessage("user", text);
      if (turnStartMs == null) markTurnStart();
    }
    return;
  }

  if (t === "input_audio_buffer.speech_started") {
    setTurn("listening");
    stopPlayback();
    if (!partialUserEl) {
      partialUserEl = beginPartial("user");
      partialUserText = "";
    }
    return;
  }

  if (t === "input_audio_buffer.speech_stopped") {
    setTurn("thinking");
    return;
  }

  if (t === "response.created") {
    if (turnStartMs == null) markTurnStart();
    if (!partialAssistantEl) {
      partialAssistantEl = beginPartial("assistant");
      partialAssistantText = "";
    }
    return;
  }

  if (t === "response.output_audio.delta" || t === "response.audio.delta") {
    const delta = event.delta || event.audio;
    if (delta) {
      markFirstAudio();
      playPcmChunk(base64ToInt16(delta));
    }
    return;
  }

  if (
    t === "response.output_audio_transcript.delta" ||
    t === "response.audio_transcript.delta" ||
    t === "response.output_text.delta" ||
    t === "response.text.delta"
  ) {
    const piece = event.delta || "";
    if (piece) {
      if (!partialAssistantEl) {
        partialAssistantEl = beginPartial("assistant");
        partialAssistantText = "";
      }
      partialAssistantText += piece;
      partialAssistantEl.querySelector(".body").textContent = partialAssistantText;
      els.chat.scrollTop = els.chat.scrollHeight;
    }
    return;
  }

  if (t === "response.done") markTurnDone();
}

function sendText() {
  const text = els.prompt.value.trim();
  if (!text) return;

  if (demoMode) {
    addMessage("user", text);
    els.prompt.value = "";
    // Offline tool demo if they mention order
    if (/order|88421|4491/i.test(text)) {
      const id = (text.match(/88421|4491|\d{4,}/) || ["88421"])[0];
      const result = executeLookupOrder({ order_id: id });
      addToolChip("lookup_order", { order_id: id }, result);
      addMessage(
        "assistant",
        `Demo CRM says order ${result.order_id} is ${result.status}${result.eta ? ` (ETA ${result.eta})` : ""}. Connect live for real tool calls mid-speech.`,
        "demo · tool",
      );
    } else {
      addMessage(
        "assistant",
        "Demo mode is offline — try an order id like 88421 to see a tool chip, or Connect with a key for live answers.",
        "demo · local",
      );
    }
    setStatus("Demo local reply.", "ok");
    return;
  }

  if (!connected) {
    showFriendlyError({
      code: "ws_closed",
      title: "Not connected",
      message: "Connect for live chat, or use Demo mode / Compare offline.",
      fix: "Click Connect (needs key) or ▶ Demo mode.",
    });
    return;
  }

  addMessage("user", text);
  els.prompt.value = "";
  markTurnStart();
  partialAssistantEl = beginPartial("assistant");
  partialAssistantText = "";
  sendEvent({
    type: "conversation.item.create",
    item: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text }],
    },
  });
  sendEvent({ type: "response.create" });
  logEvent("text turn sent");
}

function interrupt() {
  stopPlayback();
  sendEvent({ type: "response.cancel" });
  sendEvent({ type: "input_audio_buffer.clear" });
  awaitingResponse = false;
  pendingFunctionResults.length = 0;
  functionCallsInFlight = 0;
  if (partialAssistantEl) {
    finalizePartial(partialAssistantEl, partialAssistantText || "(interrupted)");
    partialAssistantEl = null;
    partialAssistantText = "";
  }
  setTurn(micSending ? "listening" : "idle");
  setStatus("Interrupted.", "ok");
  logEvent("interrupt");
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function loadHealth() {
  try {
    const res = await fetch("/api/health");
    const data = await res.json();
    els.modelName.textContent = data.model || "unknown";
    keyConfigured = !!data.key_configured;
    if (keyConfigured) {
      els.keyStatus.textContent = "API key configured";
      els.keyStatus.classList.add("ok");
      els.keyStatus.classList.remove("bad", "warn");
    } else {
      els.keyStatus.textContent = "no key · demo ok";
      els.keyStatus.classList.add("warn");
      els.keyStatus.classList.remove("ok", "bad");
    }
    els.stageHint.textContent = keyConfigured
      ? "Connect with your key, or start Demo mode offline."
      : "No API key — click Demo mode to explore the UI offline.";
    if (!keyConfigured) {
      setStatus("Tip: no API key detected. Click ▶ Demo mode, or docker compose up with .env", "ok");
    }
  } catch (err) {
    els.modelName.textContent = "offline";
    els.keyStatus.textContent = "health check failed";
    els.keyStatus.classList.add("bad");
    showFriendlyError(err);
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
        els.prompt.value = ex.text;
        els.prompt.focus();
      });
      els.examples.appendChild(btn);
    });
    (data.scenarios || []).forEach((sc) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "scenario";
      btn.textContent = sc.label;
      btn.addEventListener("click", () => {
        els.instructions.value = sc.instructions;
        els.prompt.value = sc.starter || "";
        if (sc.tools) {
          els.toolLookup.checked = !!sc.tools.lookup_order;
          els.toolWeb.checked = !!sc.tools.web_search;
        }
        if (connected) {
          sendEvent(sessionUpdatePayload());
          setStatus(`Scenario applied: ${sc.label}`, "ok");
          logEvent(`scenario ${sc.label}`);
        } else {
          setStatus("Scenario loaded — Connect or Demo, then Send.", "ok");
        }
      });
      els.scenarios.appendChild(btn);
    });
  } catch {
    /* optional */
  }
}

// Controls
els.connectBtn.addEventListener("click", () => {
  if (connected) disconnect();
  else connect();
});
els.demoBtn.addEventListener("click", () => runDemoMode());
els.compareBtn.addEventListener("click", () => runCompare());
els.sendBtn.addEventListener("click", sendText);
els.prompt.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendText();
  }
});
els.micBtn.addEventListener("click", () => toggleOpenMic());
els.interruptBtn.addEventListener("click", interrupt);
els.stopAudioBtn.addEventListener("click", stopPlayback);
els.clearBtn.addEventListener("click", clearChat);
els.exportBtn.addEventListener("click", exportSession);
els.applySessionBtn.addEventListener("click", () => {
  sendEvent(sessionUpdatePayload());
  updateMicModeUi();
  setStatus("session.update sent (voice / reasoning / tools / mic mode).", "ok");
  logEvent("session.update applied");
});
els.micMode.addEventListener("change", async () => {
  updateMicModeUi();
  if (connected) {
    await disarmMicHardware();
    sendEvent(sessionUpdatePayload());
    setStatus(
      els.micMode.value === "ptt"
        ? "Push-to-talk mode — hold Space or the button."
        : "Open mic mode — click Open mic for continuous VAD.",
      "ok",
    );
  }
});
els.toolLookup.addEventListener("change", () => {
  if (connected) sendEvent(sessionUpdatePayload());
});
els.toolWeb.addEventListener("change", () => {
  if (connected) sendEvent(sessionUpdatePayload());
});
els.toggleLogBtn.addEventListener("click", () => {
  const hidden = els.eventLog.classList.toggle("hidden");
  els.toggleLogBtn.textContent = hidden ? "Show" : "Hide";
});
els.errorDismissBtn.addEventListener("click", hideFriendlyError);
els.errorDemoBtn.addEventListener("click", () => {
  hideFriendlyError();
  runDemoMode();
});
els.cmpPlayHigh.addEventListener("click", () => {
  if (lastCompare?.high?.audio_base64) playBase64Pcm(lastCompare.high.audio_base64);
});
els.cmpPlayNone.addEventListener("click", () => {
  if (lastCompare?.none?.audio_base64) playBase64Pcm(lastCompare.none.audio_base64);
});

// Push-to-talk button
els.pttBtn.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  els.pttBtn.setPointerCapture(e.pointerId);
  pttDown();
});
els.pttBtn.addEventListener("pointerup", (e) => {
  e.preventDefault();
  pttUp();
});
els.pttBtn.addEventListener("pointercancel", () => pttUp());
els.pttBtn.addEventListener("lostpointercapture", () => pttUp());

// Space = PTT when not typing
window.addEventListener("keydown", (e) => {
  if (e.code !== "Space" && e.key !== " ") return;
  if (isTypingTarget(e.target)) return;
  if (!connected || els.micMode.value !== "ptt") return;
  e.preventDefault();
  if (!e.repeat) pttDown();
});
window.addEventListener("keyup", (e) => {
  if (e.code !== "Space" && e.key !== " ") return;
  if (!connected || els.micMode.value !== "ptt") return;
  e.preventDefault();
  pttUp();
});

els.sendBtn.disabled = true;
els.clearBtn.disabled = false;
els.exportBtn.disabled = true;

document.addEventListener("keydown", async (e) => {
  if (!(e.metaKey || e.ctrlKey) || !e.shiftKey || e.key.toLowerCase() !== "s") return;
  e.preventDefault();
  const text = els.prompt.value.trim();
  if (!text) {
    setStatus("Type a prompt first for one-shot speak.", "error");
    return;
  }
  if (!keyConfigured) {
    showFriendlyError({
      code: "missing_key",
      title: "API key not configured",
      message: "One-shot speak needs XAI_API_KEY. Use Demo or Compare offline.",
      fix: "cp .env.example .env  # set XAI_API_KEY=xai-…",
    });
    return;
  }
  setStatus("One-shot /api/speak…");
  try {
    const res = await fetch("/api/speak", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        voice: els.voice.value,
        reasoning_effort: els.reasoning.value,
        instructions: els.instructions.value,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      showFriendlyError(data);
      return;
    }
    addMessage("user", text);
    addMessage(
      "assistant",
      data.transcript || "(no transcript)",
      `one-shot · first audio ${fmtSec(data.metrics?.connect_to_first_audio_s)}`,
    );
    els.mFirst.textContent = fmtSec(data.metrics?.connect_to_first_audio_s);
    els.mDone.textContent = fmtSec(data.metrics?.connect_to_done_s);
    recordLatency(data.metrics?.connect_to_first_audio_s, {
      done_s: data.metrics?.connect_to_done_s,
      source: "one-shot",
    });
    playBase64Pcm(data.audio_base64);
    setStatus("One-shot complete.", "ok");
  } catch (err) {
    showFriendlyError(err);
  }
});

ensureEmptyChatHint();
updateMicModeUi();
drawWave();
drawSpark();
loadHealth();
loadExamples();
ensureDemoBundle().catch(() => {});
