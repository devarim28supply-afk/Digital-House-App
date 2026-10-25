// On-device live captioning: Silero VAD cuts the mic into speech segments,
// Moonshine turns each segment into text. No network once the models are cached.
// Works in the browser and in Node (pass the transformers.js module as T), so the
// same logic can be tested on a WAV file on the PC.

export const SAMPLE_RATE = 16000;
export const CHUNK = 512; // Silero v5 frame at 16 kHz = 32 ms

export const MODELS = {
  base: "onnx-community/moonshine-base-ONNX",
  tiny: "onnx-community/moonshine-tiny-ONNX"
};

const CHUNK_MS = (CHUNK / SAMPLE_RATE) * 1000;
const START_PROB = 0.4;       // VAD probability that opens a segment
const KEEP_PROB = 0.2;        // ...and keeps it open
const END_SILENCE_MS = 550;   // quiet this long closes the segment
const PRE_ROLL_MS = 320;      // audio kept from before speech started (first syllable)
const MIN_SPEECH_MS = 250;    // shorter blips are dropped (clicks, bumps)
const MAX_SEGMENT_MS = 12000; // long talkers get cut so text keeps flowing
const INTERIM_EVERY_MS = 900; // how often the grey "still talking" line refreshes
const AGC_TARGET = 0.5;       // peak level the VAD sees; it misses quiet (far) speech
const AGC_MAX_GAIN = 40;
const BACKLOG_LIMIT = 40;     // chunks (~1.3 s); past this we skip interims to catch up

export async function createCaptioner(T, opts) {
  const { device = "wasm", model = "base", onInterim, onFinal, onProgress } = opts;

  const vad = await T.AutoModel.from_pretrained("onnx-community/silero-vad", {
    config: { model_type: "custom" },
    dtype: "fp32",
    progress_callback: onProgress
  });

  const asr = await T.pipeline("automatic-speech-recognition", MODELS[model], {
    device,
    dtype: device === "webgpu"
      ? { encoder_model: "fp32", decoder_model_merged: "q4" }
      : { encoder_model: "q8", decoder_model_merged: "q8" }, // 8-bit: ~63 MB base / ~28 MB tiny, safe for iPhone memory
    progress_callback: onProgress
  });

  const sr = new T.Tensor("int64", [SAMPLE_RATE], []);
  let state = new T.Tensor("float32", new Float32Array(2 * 128), [2, 1, 128]);

  const queue = [];
  let pumping = false;
  let preRoll = [];
  let speech = [];        // chunks of the open segment
  let speaking = false;
  let silentMs = 0;
  let sinceInterimMs = 0;
  let envelope = AGC_TARGET;

  // Automatic gain: fast attack, ~6 s release, so a far voice is lifted
  // to the same level as a near one before the VAD judges it.
  function level(chunk) {
    let peak = 0;
    for (let i = 0; i < chunk.length; i++) peak = Math.max(peak, Math.abs(chunk[i]));
    envelope = peak > envelope ? envelope * 0.7 + peak * 0.3 : envelope * 0.995 + peak * 0.005;
    const g = Math.min(AGC_TARGET / Math.max(envelope, 1e-5), AGC_MAX_GAIN);
    if (g === 1) return chunk;
    const out = new Float32Array(chunk.length);
    for (let i = 0; i < chunk.length; i++) out[i] = Math.max(-1, Math.min(1, chunk[i] * g));
    return out;
  }

  async function speechProb(chunk) {
    const input = new T.Tensor("float32", chunk, [1, chunk.length]);
    const { output, stateN } = await vad({ input, sr, state });
    state = stateN;
    return output.data[0];
  }

  async function transcribe(chunks) {
    const audio = normalize(concat(chunks));
    const seconds = audio.length / SAMPLE_RATE;
    const out = await asr(audio, { max_new_tokens: Math.min(220, Math.ceil(seconds * 6.5) + 8) });
    return clean(out.text);
  }

  async function closeSegment() {
    const chunks = speech;
    speech = [];
    speaking = false;
    silentMs = 0;
    sinceInterimMs = 0;
    if (chunks.length * CHUNK_MS < MIN_SPEECH_MS + PRE_ROLL_MS) { onInterim?.(""); return; }
    const text = await transcribe(chunks);
    onInterim?.("");
    if (text) onFinal?.(text);
  }

  async function step(raw) {
    const chunk = level(raw);
    const p = await speechProb(chunk);
    if (!speaking) {
      preRoll.push(chunk);
      if (preRoll.length * CHUNK_MS > PRE_ROLL_MS) preRoll.shift();
      if (p >= START_PROB) {
        speaking = true;
        speech = preRoll;
        preRoll = [];
      }
      return;
    }
    speech.push(chunk);
    sinceInterimMs += CHUNK_MS;
    silentMs = p < KEEP_PROB ? silentMs + CHUNK_MS : 0;

    if (silentMs >= END_SILENCE_MS || speech.length * CHUNK_MS >= MAX_SEGMENT_MS) {
      await closeSegment();
    } else if (sinceInterimMs >= INTERIM_EVERY_MS && queue.length < BACKLOG_LIMIT) {
      sinceInterimMs = 0;
      const text = await transcribe(speech);
      if (speaking) onInterim?.(text);
    }
  }

  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (queue.length) await step(queue.shift());
    } finally {
      pumping = false;
    }
  }

  return {
    // chunk: Float32Array of CHUNK samples at 16 kHz
    push(chunk) { queue.push(chunk); pump(); },
    // Finish whatever is being said right now (used on Stop and at end of a file).
    async flush() {
      while (pumping || queue.length) { await pump(); await new Promise(r => setTimeout(r, 10)); }
      if (speaking) await closeSegment();
    },
    backlog: () => queue.length,
    // One silent pass so WebGPU compiles its shaders before the first real words.
    async warmup() { await asr(new Float32Array(SAMPLE_RATE), { max_new_tokens: 4 }); },
    async dispose() { await asr.dispose?.(); await vad.dispose?.(); }
  };
}

function concat(chunks) {
  const out = new Float32Array(chunks.length * CHUNK);
  chunks.forEach((c, i) => out.set(c, i * CHUNK));
  return out;
}

// Far-away voices arrive quiet; bring every segment up to the same loudness.
function normalize(a) {
  let peak = 0;
  for (let i = 0; i < a.length; i++) peak = Math.max(peak, Math.abs(a[i]));
  if (peak < 1e-4) return a;
  const g = Math.min(0.9 / peak, 30);
  for (let i = 0; i < a.length; i++) a[i] *= g;
  return a;
}

// Trim, drop empty / punctuation-only output, squash the "the the the the" loops
// small models sometimes fall into.
export function clean(text) {
  let t = (text || "").replace(/\s+/g, " ").trim();
  t = t.replace(/\b(\w+(?:\s+\w+){0,2})(?:[\s,]+\1\b){3,}/gi, "$1");
  return /[a-z0-9]/i.test(t) ? t : "";
}
