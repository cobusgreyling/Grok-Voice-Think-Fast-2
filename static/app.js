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
  micBtn: $("micBtn"),
  interruptBtn: $("interruptBtn"),
  clearBtn: $("clearBtn"),
  sendBtn: $("sendBtn"),
  stopAudioBtn: $("stopAudioBtn"),
  applySessionBtn: $("applySessionBtn"),
  prompt: $("prompt"),
  voice: $("voice"),
  reasoning: $("reasoning"),
  vad: $("vad"),
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
};

/** @type {WebSocket | null} */
let ws = null;
/** @type {AudioContext | null} */
let audioCtx = null;
/** @type {MediaStream | null} */
let micStream = null;
/** @type {ScriptProcessorNode | null} */
let micProcessor = null;
/** @type {MediaStreamAudioSourceNode | null} */
let micSource = null;
let micEnabled = false;
let connected = false;
let demoMode = false;
let speaking = false;
let awaitingResponse = false;
let turnStartMs = null;
let firstAudioMs = null;
let turnCount = 0;
let keyConfigured = false;
let demoAvailable = true;
const latencyHistory = [];
/** @type {any} */
let demoBundle = null;
/** @type {any} */
let lastCompare = null;

let nextPlayTime = 0;
/** @type {AudioBufferSourceNode[]} */
const activeSources = [];

let partialAssistantEl = null;
let partialUserEl = null;
let partialAssistantText = "";
let partialUserText = "";

const waveCtx = els.wave.getContext("2d");
const sparkCtx = els.spark.getContext("2d");
const waveLevels = new Float32Array(64);
let waveWrite = 0;

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
  if (typeof err === "string") {
    return classifyClientString(err);
  }
  // FastAPI {detail: {...}} or {detail: "str"}
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
      message: "Is `python app.py` running on port 7861?",
      fix: "./run.sh   # then open http://127.0.0.1:7861",
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
  else if (state === "demo") els.connStatus.classList.add("warn");
  else if (state === "connecting") els.connStatus.classList.add("warn");
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
  const next = `[${ts}] ${line}\n${els.eventLog.textContent}`;
  els.eventLog.textContent = next.slice(0, 8000);
}

function fmtSec(v) {
  if (v == null || Number.isNaN(v)) return "—";
  return `${Number(v).toFixed(2)}s`;
}

function ensureAudioCtx() {
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    audioCtx = new AC({ sampleRate: SAMPLE_RATE });
  }
  if (audioCtx.state === "suspended") audioCtx.resume();
  return audioCtx;
}

function setLiveUi(isOn) {
  connected = isOn;
  if (isOn) demoMode = false;
  els.liveDot.hidden = !isOn;
  if (isOn) els.demoDot.hidden = true;
  els.connectBtn.textContent = isOn ? "Disconnect" : "Connect";
  els.sendBtn.disabled = !(isOn || demoMode);
  els.micBtn.disabled = !isOn;
  els.interruptBtn.disabled = !isOn;
  els.clearBtn.disabled = !(isOn || demoMode);
  els.applySessionBtn.disabled = !isOn;
  els.demoBtn.disabled = isOn;
  if (isOn) {
    setConn("connected");
    setTurn(micEnabled ? "listening" : "idle");
    els.stageHint.textContent = "Session live — type, use a scenario, or enable the mic.";
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
      els.stageHint.textContent = keyConfigured
        ? "Connect with your key, or start Demo mode offline."
        : "No API key detected — start Demo mode, or add XAI_API_KEY.";
    }
  }
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
      : micEnabled
        ? `rgba(52, 211, 153, ${0.35 + v * 0.65})`
        : `rgba(167, 139, 250, ${0.25 + v * 0.5})`;
    waveCtx.fillRect(x + 1, y, Math.max(1, barW - 2), barH);
  }
  requestAnimationFrame(drawWave);
}

function recordLatency(sec) {
  if (sec == null || Number.isNaN(sec)) return;
  latencyHistory.push(sec);
  if (latencyHistory.length > 24) latencyHistory.shift();
  const avg = latencyHistory.reduce((a, b) => a + b, 0) / latencyHistory.length;
  els.mAvg.textContent = fmtSec(avg);
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
// Chat
// ---------------------------------------------------------------------------

function ensureEmptyChatHint() {
  if (!els.chat.children.length) {
    const empty = document.createElement("div");
    empty.className = "empty-chat";
    empty.id = "emptyChat";
    empty.textContent = keyConfigured
      ? "No turns yet. Connect, Demo mode, or Compare high vs none."
      : "No API key — click Demo mode to explore offline, or add XAI_API_KEY.";
    els.chat.appendChild(empty);
  }
}

function clearEmptyHint() {
  const empty = $("emptyChat");
  if (empty) empty.remove();
}

function addMessage(role, text, meta = "") {
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
  return div;
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
  els.chat.scrollTop = els.chat.scrollHeight;
}

function clearChat() {
  els.chat.innerHTML = "";
  ensureEmptyChatHint();
  partialAssistantEl = null;
  partialUserEl = null;
  partialAssistantText = "";
  partialUserText = "";
}

// ---------------------------------------------------------------------------
// Audio
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
  if ((connected || demoMode) && !awaitingResponse) setTurn(micEnabled ? "listening" : "idle");
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
      if (connected || demoMode) setTurn(micEnabled ? "listening" : "idle");
    }
  };
}

function base64ToInt16(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Int16Array(bytes.buffer);
}

function playBase64Pcm(b64, sampleRate = SAMPLE_RATE) {
  // if sample rates mismatch, still play at SAMPLE_RATE for demo tones
  void sampleRate;
  stopPlayback();
  playPcmChunk(base64ToInt16(b64));
}

function floatTo16BitPCM(float32) {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i += 1) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

function int16ToBase64(int16) {
  const bytes = new Uint8Array(int16.buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function downsampleToRate(float32, fromRate, toRate) {
  if (fromRate === toRate) return floatTo16BitPCM(float32);
  const ratio = fromRate / toRate;
  const newLen = Math.round(float32.length / ratio);
  const result = new Float32Array(newLen);
  for (let i = 0; i < newLen; i += 1) result[i] = float32[Math.floor(i * ratio)] || 0;
  return floatTo16BitPCM(result);
}

async function startMic() {
  if (micEnabled || !connected) return;
  const ctx = ensureAudioCtx();
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
    return;
  }
  micSource = ctx.createMediaStreamSource(micStream);
  micProcessor = ctx.createScriptProcessor(4096, 1, 1);
  micProcessor.onaudioprocess = (e) => {
    if (!micEnabled || !ws || ws.readyState !== WebSocket.OPEN) return;
    const input = e.inputBuffer.getChannelData(0);
    const pcm = downsampleToRate(input, ctx.sampleRate, SAMPLE_RATE);
    let peak = 0;
    for (let i = 0; i < input.length; i += 5) peak = Math.max(peak, Math.abs(input[i]));
    pushWaveLevel(Math.min(1, peak * 2.2));
    sendEvent({ type: "input_audio_buffer.append", audio: int16ToBase64(pcm) });
  };
  const mute = ctx.createGain();
  mute.gain.value = 0;
  micSource.connect(micProcessor);
  micProcessor.connect(mute);
  mute.connect(ctx.destination);
  micEnabled = true;
  els.micBtn.textContent = "🎙 Mic on";
  els.micBtn.classList.add("active-mic");
  setTurn(speaking ? "speaking" : "listening");
  logEvent("mic started");
  setStatus("Mic live — server VAD detects turns when enabled.", "ok");
}

function stopMic() {
  micEnabled = false;
  els.micBtn.textContent = "🎙 Mic off";
  els.micBtn.classList.remove("active-mic");
  if (micProcessor) {
    try {
      micProcessor.disconnect();
    } catch {
      /* */
    }
    micProcessor.onaudioprocess = null;
    micProcessor = null;
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
  logEvent("mic stopped");
  if (connected && !speaking && !awaitingResponse) setTurn("idle");
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
      recordLatency(first);
      (turn.events || []).forEach((ev) => logEvent(ev));
      if (turn.audio_base64) {
        playBase64Pcm(turn.audio_base64, data.sample_rate || SAMPLE_RATE);
        await sleep(Math.min(2200, (done || 1.5) * 900));
      }
      setTurn("idle");
      await sleep(400);
    }
    setStatus("Demo complete. Connect with a key for live voice, or run Compare.", "ok");
  } catch (err) {
    setDemoUi(false);
    showFriendlyError(err);
  }
}

// ---------------------------------------------------------------------------
// Compare high vs none
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

    recordLatency(data.high?.metrics?.first_audio_s);
    recordLatency(data.none?.metrics?.first_audio_s);
    els.mFirst.textContent = fmtSec(data.none?.metrics?.first_audio_s);
    els.mDone.textContent = fmtSec(data.none?.metrics?.done_s);
    turnCount += 2;
    els.mTurns.textContent = String(turnCount);

    // Play high then none
    if (data.high?.audio_base64) {
      playBase64Pcm(data.high.audio_base64, data.sample_rate || SAMPLE_RATE);
      await sleep(1600);
    }
    if (data.none?.audio_base64) {
      playBase64Pcm(data.none.audio_base64, data.sample_rate || SAMPLE_RATE);
    }
    setStatus(`Compare done (${data.source}).`, "ok");
    logEvent(`compare done source=${data.source}`);
  } catch (err) {
    showFriendlyError(err);
  } finally {
    els.compareBtn.disabled = false;
    setTurn(connected || demoMode ? "idle" : "idle");
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
  const vadMode = els.vad.value;
  const session = {
    voice: els.voice.value,
    instructions: els.instructions.value.trim(),
    reasoning: { effort: els.reasoning.value },
    audio: {
      input: { format: { type: "audio/pcm", rate: SAMPLE_RATE } },
      output: { format: { type: "audio/pcm", rate: SAMPLE_RATE } },
    },
  };
  if (vadMode === "server_vad") {
    session.turn_detection = {
      type: "server_vad",
      threshold: 0.85,
      silence_duration_ms: 600,
      prefix_padding_ms: 300,
    };
  } else {
    session.turn_detection = null;
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
    recordLatency(sec);
  }
  speaking = true;
  setTurn("speaking");
}

function markTurnDone() {
  if (turnStartMs != null) {
    els.mDone.textContent = fmtSec((performance.now() - turnStartMs) / 1000);
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
  if (!speaking) setTurn(micEnabled ? "listening" : "idle");
  turnStartMs = null;
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
      fix: "cp .env.example .env  # then set XAI_API_KEY=xai-… from console.x.ai",
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
    setStatus("Connected. Send a message or turn the mic on.", "ok");
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

  ws.onclose = () => {
    stopMic();
    stopPlayback();
    setLiveUi(false);
    ws = null;
    logEvent("disconnected");
  };
}

function disconnect() {
  stopMic();
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
    setTurn(micEnabled ? "listening" : "idle");
    return;
  }

  if (t === "session.updated" || t === "session.created") {
    setStatus("Session ready.", "ok");
    return;
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
      markTurnStart();
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
    // In demo mode, free-form text maps to a synthetic local reply using last demo style
    addMessage("user", text);
    els.prompt.value = "";
    const reply =
      "Demo mode is offline — recorded audio only. Connect with XAI_API_KEY for live answers, or run Compare.";
    addMessage("assistant", reply, "demo · local");
    setStatus("Demo mode cannot call the model for free-form chat.", "ok");
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
  if (partialAssistantEl) {
    finalizePartial(partialAssistantEl, partialAssistantText || "(interrupted)");
    partialAssistantEl = null;
    partialAssistantText = "";
  }
  setTurn(micEnabled ? "listening" : "idle");
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
    demoAvailable = !!data.demo_available;
    if (keyConfigured) {
      els.keyStatus.textContent = "API key configured";
      els.keyStatus.classList.add("ok");
      els.keyStatus.classList.remove("bad");
    } else {
      els.keyStatus.textContent = "no key · demo ok";
      els.keyStatus.classList.add("warn");
      els.keyStatus.classList.remove("ok", "bad");
    }
    els.stageHint.textContent = keyConfigured
      ? "Connect with your key, or start Demo mode offline."
      : "No API key — click Demo mode to explore the UI offline.";
    if (!keyConfigured && demoAvailable) {
      setStatus("Tip: no API key detected. Click ▶ Demo mode to try the lab offline.", "ok");
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
els.micBtn.addEventListener("click", async () => {
  if (micEnabled) stopMic();
  else await startMic();
});
els.interruptBtn.addEventListener("click", interrupt);
els.stopAudioBtn.addEventListener("click", stopPlayback);
els.clearBtn.addEventListener("click", clearChat);
els.applySessionBtn.addEventListener("click", () => {
  sendEvent(sessionUpdatePayload());
  setStatus("session.update sent.", "ok");
  logEvent("session.update applied");
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
  if (lastCompare?.high?.audio_base64) {
    playBase64Pcm(lastCompare.high.audio_base64, lastCompare.sample_rate || SAMPLE_RATE);
  }
});
els.cmpPlayNone.addEventListener("click", () => {
  if (lastCompare?.none?.audio_base64) {
    playBase64Pcm(lastCompare.none.audio_base64, lastCompare.sample_rate || SAMPLE_RATE);
  }
});

// Enable send when not live if demo; keep enabled for compare prompt prep
els.sendBtn.disabled = true;
els.clearBtn.disabled = false;

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
    recordLatency(data.metrics?.connect_to_first_audio_s);
    playBase64Pcm(data.audio_base64, data.sample_rate || SAMPLE_RATE);
    setStatus("One-shot complete.", "ok");
  } catch (err) {
    showFriendlyError(err);
  }
});

ensureEmptyChatHint();
drawWave();
drawSpark();
loadHealth();
loadExamples();
// Preload demo fixture for faster offline paths
ensureDemoBundle().catch(() => {});
