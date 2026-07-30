/* global AudioContext, webkitAudioContext */

const SAMPLE_RATE = 24000;

const $ = (id) => document.getElementById(id);

const els = {
  modelName: $("modelName"),
  keyStatus: $("keyStatus"),
  connStatus: $("connStatus"),
  turnStatus: $("turnStatus"),
  connectBtn: $("connectBtn"),
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
  stageHint: $("stageHint"),
  orb: $("orb"),
  orbCore: $("orbCore"),
  wave: $("wave"),
  spark: $("spark"),
  mFirst: $("mFirst"),
  mDone: $("mDone"),
  mTurns: $("mTurns"),
  mAvg: $("mAvg"),
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
let speaking = false;
let awaitingResponse = false;
let turnStartMs = null;
let firstAudioMs = null;
let turnCount = 0;
const latencyHistory = [];

/** streaming playback */
let nextPlayTime = 0;
/** @type {AudioBufferSourceNode[]} */
const activeSources = [];

/** chat partials */
let partialAssistantEl = null;
let partialUserEl = null;
let partialAssistantText = "";
let partialUserText = "";

const waveCtx = els.wave.getContext("2d");
const sparkCtx = els.spark.getContext("2d");
const waveLevels = new Float32Array(64);
let waveWrite = 0;

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
    els.orbCore.textContent = connected ? "●" : "○";
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

function setConnectedUi(isOn) {
  connected = isOn;
  els.liveDot.hidden = !isOn;
  els.connectBtn.textContent = isOn ? "Disconnect" : "Connect";
  els.prompt.disabled = !isOn;
  els.sendBtn.disabled = !isOn;
  els.micBtn.disabled = !isOn;
  els.interruptBtn.disabled = !isOn;
  els.clearBtn.disabled = !isOn;
  els.applySessionBtn.disabled = !isOn;
  els.stageHint.textContent = isOn
    ? "Session live — type, use a scenario, or enable the mic."
    : "Connect to start a persistent Realtime conversation.";
  if (!isOn) {
    setConn("disconnected");
    setTurn("idle");
  } else {
    setConn("connected");
    setTurn(micEnabled ? "listening" : "idle");
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
    const speakingTint = speaking;
    waveCtx.fillStyle = speakingTint
      ? `rgba(56, 189, 248, ${0.35 + v * 0.65})`
      : micEnabled
        ? `rgba(52, 211, 153, ${0.35 + v * 0.65})`
        : `rgba(167, 139, 250, ${0.25 + v * 0.5})`;
    waveCtx.fillRect(x + 1, y, Math.max(1, barW - 2), barH);
  }
  requestAnimationFrame(drawWave);
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

  // 0.70s reference line
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
    empty.textContent = "No turns yet. Connect, then send a message or enable the mic.";
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
  const role = el.classList.contains("user") ? "You" : "Grok Voice";
  el.querySelector(".role").textContent = role;
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

// ---------------------------------------------------------------------------
// Audio playback (streaming PCM16)
// ---------------------------------------------------------------------------

function stopPlayback() {
  activeSources.forEach((s) => {
    try {
      s.stop();
    } catch {
      /* already stopped */
    }
  });
  activeSources.length = 0;
  nextPlayTime = 0;
  speaking = false;
  els.stopAudioBtn.disabled = true;
  if (connected && !awaitingResponse) setTurn(micEnabled ? "listening" : "idle");
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
  source.onended = () => {
    const idx = activeSources.indexOf(source);
    if (idx >= 0) activeSources.splice(idx, 1);
    if (!activeSources.length && !awaitingResponse) {
      speaking = false;
      els.stopAudioBtn.disabled = true;
      if (connected) setTurn(micEnabled ? "listening" : "idle");
    }
  };
}

function base64ToInt16(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Int16Array(bytes.buffer);
}

// ---------------------------------------------------------------------------
// Mic capture
// ---------------------------------------------------------------------------

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

async function startMic() {
  if (micEnabled) return;
  const ctx = ensureAudioCtx();
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
  micSource = ctx.createMediaStreamSource(micStream);
  // ScriptProcessor is deprecated but widely supported for demos; buffer 4096
  micProcessor = ctx.createScriptProcessor(4096, 1, 1);
  micProcessor.onaudioprocess = (e) => {
    if (!micEnabled || !ws || ws.readyState !== WebSocket.OPEN) return;
    const input = e.inputBuffer.getChannelData(0);
    // Resample-ish: if context rate != 24000, simple decimate/interpolate
    const pcm = downsampleTo16kOr24k(input, ctx.sampleRate, SAMPLE_RATE);
    let peak = 0;
    for (let i = 0; i < input.length; i += 5) peak = Math.max(peak, Math.abs(input[i]));
    pushWaveLevel(Math.min(1, peak * 2.2));

    const b64 = int16ToBase64(pcm);
    sendEvent({
      type: "input_audio_buffer.append",
      audio: b64,
    });
  };
  micSource.connect(micProcessor);
  micProcessor.connect(ctx.destination); // keep processor alive; volume is tiny if silent graph
  // Mute local monitoring: disconnect destination and use a zero-gain trick
  micProcessor.disconnect();
  const mute = ctx.createGain();
  mute.gain.value = 0;
  micProcessor.connect(mute);
  mute.connect(ctx.destination);

  micEnabled = true;
  els.micBtn.textContent = "🎙 Mic on";
  els.micBtn.classList.add("active-mic");
  setTurn(speaking ? "speaking" : "listening");
  logEvent("mic started");
  setStatus("Mic live — server VAD will detect turns automatically (if enabled).", "ok");
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

function downsampleTo16kOr24k(float32, fromRate, toRate) {
  if (fromRate === toRate) return floatTo16BitPCM(float32);
  const ratio = fromRate / toRate;
  const newLen = Math.round(float32.length / ratio);
  const result = new Float32Array(newLen);
  for (let i = 0; i < newLen; i += 1) {
    const idx = Math.floor(i * ratio);
    result[i] = float32[idx] || 0;
  }
  return floatTo16BitPCM(result);
}

// ---------------------------------------------------------------------------
// WebSocket session
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
    latencyHistory.push(sec);
    if (latencyHistory.length > 24) latencyHistory.shift();
    const avg = latencyHistory.reduce((a, b) => a + b, 0) / latencyHistory.length;
    els.mAvg.textContent = fmtSec(avg);
    drawSpark();
  }
  speaking = true;
  setTurn("speaking");
}

function markTurnDone() {
  if (turnStartMs != null) {
    const done = (performance.now() - turnStartMs) / 1000;
    els.mDone.textContent = fmtSec(done);
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

  setConn("connecting");
  setStatus("Connecting to Realtime proxy…");
  logEvent("connecting…");
  ensureAudioCtx();

  ws = new WebSocket(wsUrl());
  ws.binaryType = "arraybuffer";

  ws.onopen = () => {
    setConnectedUi(true);
    sendEvent(sessionUpdatePayload());
    logEvent("connected + session.update sent");
    setStatus("Connected. Send a message or turn the mic on.", "ok");
  };

  ws.onmessage = (ev) => {
    if (typeof ev.data !== "string") {
      // binary audio frames (if transport=binary ever used)
      const int16 = new Int16Array(ev.data);
      markFirstAudio();
      playPcmChunk(int16);
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
    setStatus("WebSocket error — is the server running and XAI_API_KEY set?", "error");
    logEvent("ws error");
  };

  ws.onclose = () => {
    stopMic();
    stopPlayback();
    setConnectedUi(false);
    ws = null;
    logEvent("disconnected");
    setStatus("Disconnected.");
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
  setConnectedUi(false);
}

function handleServerEvent(event) {
  const t = event.type || "unknown";
  if (
    t.includes("delta") ||
    t === "response.output_audio.delta" ||
    t === "response.audio.delta"
  ) {
    // don't flood log with every audio delta
    if (!t.includes("audio")) logEvent(t);
  } else {
    logEvent(t);
  }

  if (t === "error" || event.error) {
    const msg =
      event.error?.message ||
      event.message ||
      (typeof event.error === "string" ? event.error : JSON.stringify(event.error || event));
    setStatus(msg, "error");
    awaitingResponse = false;
    setTurn(micEnabled ? "listening" : "idle");
    return;
  }

  if (t === "session.updated" || t === "session.created") {
    setStatus("Session ready.", "ok");
    return;
  }

  // User speech transcription (server VAD path)
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
      } else if (text) {
        addMessage("user", text);
      }
      markTurnStart();
    }
    return;
  }

  if (t === "input_audio_buffer.speech_started") {
    setTurn("listening");
    stopPlayback(); // barge-in
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

  if (t === "response.done") {
    markTurnDone();
    return;
  }
}

function sendText() {
  const text = els.prompt.value.trim();
  if (!text || !connected) return;
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
  // clear pending input audio if any
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

function clearChat() {
  els.chat.innerHTML = "";
  ensureEmptyChatHint();
  partialAssistantEl = null;
  partialUserEl = null;
  partialAssistantText = "";
  partialUserText = "";
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function loadHealth() {
  try {
    const res = await fetch("/api/health");
    const data = await res.json();
    els.modelName.textContent = data.model || "unknown";
    if (data.key_configured) {
      els.keyStatus.textContent = "API key configured";
      els.keyStatus.classList.add("ok");
    } else {
      els.keyStatus.textContent = "XAI_API_KEY missing";
      els.keyStatus.classList.add("bad");
    }
  } catch {
    els.modelName.textContent = "offline";
    els.keyStatus.textContent = "health check failed";
    els.keyStatus.classList.add("bad");
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
        if (connected) els.prompt.focus();
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
          setStatus("Scenario loaded — hit Connect, then Send.", "ok");
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

els.sendBtn.addEventListener("click", sendText);

els.prompt.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendText();
  }
});

els.micBtn.addEventListener("click", async () => {
  try {
    if (micEnabled) stopMic();
    else await startMic();
  } catch (err) {
    setStatus(`Mic error: ${err.message || err}`, "error");
    logEvent(`mic error ${err}`);
  }
});

els.interruptBtn.addEventListener("click", interrupt);
els.stopAudioBtn.addEventListener("click", stopPlayback);
els.clearBtn.addEventListener("click", clearChat);

els.applySessionBtn.addEventListener("click", () => {
  sendEvent(sessionUpdatePayload());
  setStatus("session.update sent (voice / reasoning / VAD / instructions).", "ok");
  logEvent("session.update applied");
});

els.toggleLogBtn.addEventListener("click", () => {
  const hidden = els.eventLog.classList.toggle("hidden");
  els.toggleLogBtn.textContent = hidden ? "Show" : "Hide";
});

// One-shot latency path kept available via keyboard shortcut for power users
// (Ctrl/Cmd+Shift+S) — still hits /api/speak without needing a live session.
document.addEventListener("keydown", async (e) => {
  if (!(e.metaKey || e.ctrlKey) || !e.shiftKey || e.key.toLowerCase() !== "s") return;
  e.preventDefault();
  const text = els.prompt.value.trim();
  if (!text) {
    setStatus("Type a prompt first for one-shot speak.", "error");
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
    if (!res.ok) throw new Error(typeof data.detail === "string" ? data.detail : JSON.stringify(data.detail));
    addMessage("user", text);
    addMessage(
      "assistant",
      data.transcript || "(no transcript)",
      `one-shot · first audio ${fmtSec(data.metrics?.connect_to_first_audio_s)}`,
    );
    els.mFirst.textContent = fmtSec(data.metrics?.connect_to_first_audio_s);
    els.mDone.textContent = fmtSec(data.metrics?.connect_to_done_s);
    if (data.metrics?.connect_to_first_audio_s != null) {
      latencyHistory.push(data.metrics.connect_to_first_audio_s);
      drawSpark();
    }
    ensureAudioCtx();
    playPcmChunk(base64ToInt16(data.audio_base64));
    setStatus("One-shot complete.", "ok");
  } catch (err) {
    setStatus(err.message || String(err), "error");
  }
});

ensureEmptyChatHint();
drawWave();
drawSpark();
loadHealth();
loadExamples();
