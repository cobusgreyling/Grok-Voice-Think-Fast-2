/**
 * Captures mono float audio and downsamples to a target rate (default 24 kHz),
 * posting Int16 PCM chunks to the main thread.
 */
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = options.processorOptions || {};
    this.targetRate = opts.targetRate || 24000;
    this.frameSamples = opts.frameSamples || 480; // 20ms @ 24kHz
    this._ratio = sampleRate / this.targetRate;
    this._pos = 0;
    this._buf = new Int16Array(this.frameSamples);
    this._bufPos = 0;
    this._enabled = true;
    this.port.onmessage = (ev) => {
      if (ev.data && ev.data.type === "set-enabled") {
        this._enabled = !!ev.data.enabled;
      }
    };
  }

  process(inputs) {
    if (!this._enabled) return true;
    const input = inputs[0] && inputs[0][0];
    if (!input || input.length === 0) return true;

    // Linear resample input (native rate) → targetRate
    while (this._pos < input.length) {
      const i0 = Math.floor(this._pos);
      const i1 = Math.min(i0 + 1, input.length - 1);
      const frac = this._pos - i0;
      const sample = input[i0] * (1 - frac) + input[i1] * frac;
      const s = Math.max(-1, Math.min(1, sample));
      this._buf[this._bufPos++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      this._pos += this._ratio;

      if (this._bufPos >= this.frameSamples) {
        // Transferable copy for the main thread
        const out = this._buf.slice(0);
        let peak = 0;
        for (let i = 0; i < out.length; i += 8) {
          const v = Math.abs(out[i] / 32768);
          if (v > peak) peak = v;
        }
        this.port.postMessage({ type: "pcm", pcm: out.buffer, peak }, [out.buffer]);
        this._buf = new Int16Array(this.frameSamples);
        this._bufPos = 0;
      }
    }
    this._pos -= input.length;
    if (this._pos < 0) this._pos = 0;
    return true;
  }
}

registerProcessor("pcm-capture", PcmCaptureProcessor);
