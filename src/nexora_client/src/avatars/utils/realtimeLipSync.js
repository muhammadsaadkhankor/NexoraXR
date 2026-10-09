// Real-time lipsync: taps the professor's <audio> element through a Web Audio
// AnalyserNode and classifies each frame's spectrum into an Oculus-style
// viseme target. Replaces the offline Rhubarb mouthCue pipeline — the output
// is always perfectly aligned with playback because it IS the playback.

let audioCtx = null;
const sourceByElement = new WeakMap();

// Spectral band edges in Hz. Anything above fHigh is sibilance-dominated.
const BANDS = {
  low: [120, 700],     // vowel body / voiced fundamental region
  mid: [700, 2500],    // F2 region, most consonant cues
  high: [2500, 8000],  // /s/, /sh/, /f/, /th/ frication
};

// Below this RMS the mouth is considered closed.
const SILENCE_RMS = 0.015;
// RMS that maps to a fully open mouth.
const FULL_OPEN_RMS = 0.12;

function getContext() {
  if (!audioCtx) {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    audioCtx = new Ctor();
  }
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  return audioCtx;
}

// Route element -> source -> analyser -> destination so the element keeps
// playing audibly while we tap it. Returns null if Web Audio is unavailable
// or the element is already owned by another context.
export function attachAnalyser(audioEl) {
  if (!audioEl) return null;
  const ctx = getContext();
  if (!ctx) return null;
  try {
    // crossOrigin must be set before src, otherwise the source is tainted
    // and the analyser returns silence. Server sends permissive CORS.
    audioEl.crossOrigin = 'anonymous';
    const source = ctx.createMediaElementSource(audioEl);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.35;
    source.connect(analyser);
    analyser.connect(ctx.destination);
    const entry = { source, analyser };
    sourceByElement.set(audioEl, entry);
    return analyser;
  } catch {
    return null;
  }
}

// Tap an existing source node for lipsync. Remote mic signals (echo-
// cancellation, AGC, Opus compression) are much quieter than local TTS
// playback, so the tap gets its own boost gain — this only feeds the
// analyser, not the speakers.
export function attachStreamAnalyser(sourceNode, ctx, boost = 3) {
  if (!sourceNode || !ctx) return null;
  try {
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const gain = ctx.createGain();
    gain.gain.value = boost;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.35;
    sourceNode.connect(gain);
    gain.connect(analyser); // tap only — audio path is wired separately
    return { gain, analyser };
  } catch {
    return null;
  }
}

export function detachAnalyser(audioEl) {
  const entry = audioEl && sourceByElement.get(audioEl);
  if (!entry) return;
  try { entry.source.disconnect(); } catch {}
  try { entry.analyser.disconnect(); } catch {}
  sourceByElement.delete(audioEl);
}

const _timeBuf = new Uint8Array(1024);
const _freqBuf = new Uint8Array(512);

function bandEnergy(freqData, sampleRate, [lo, hi]) {
  const binHz = sampleRate / 2 / freqData.length;
  const from = Math.max(0, Math.floor(lo / binHz));
  const to = Math.min(freqData.length - 1, Math.ceil(hi / binHz));
  let sum = 0;
  for (let i = from; i <= to; i++) sum += freqData[i] / 255;
  return sum / Math.max(1, to - from + 1);
}

// Classify the current frame into { viseme, level }.
// viseme is one of the morph target names (viseme_*), level is 0..1.
// opts.silenceRms / opts.fullOpenRms override the thresholds for quieter
// sources (e.g. boosted remote mic streams still vary a lot per device).
export function analyseViseme(analyser, opts = {}) {
  if (!analyser) return { viseme: 'viseme_sil', level: 0 };
  const silenceRms = opts.silenceRms ?? SILENCE_RMS;
  const fullOpenRms = opts.fullOpenRms ?? FULL_OPEN_RMS;

  analyser.getByteTimeDomainData(_timeBuf);
  let sum = 0;
  for (let i = 0; i < analyser.fftSize; i++) {
    const v = (_timeBuf[i] - 128) / 128;
    sum += v * v;
  }
  const rms = Math.sqrt(sum / analyser.fftSize);
  if (rms < silenceRms) return { viseme: 'viseme_sil', level: 0 };

  const level = Math.min(1, rms / fullOpenRms);
  analyser.getByteFrequencyData(_freqBuf);
  const sr = analyser.context.sampleRate;
  const low = bandEnergy(_freqBuf, sr, BANDS.low);
  const mid = bandEnergy(_freqBuf, sr, BANDS.mid);
  const high = bandEnergy(_freqBuf, sr, BANDS.high);
  const total = low + mid + high + 1e-6;
  const highRatio = high / total;
  const midRatio = mid / total;

  // Fricatives/sibilants ride on high-band noise; vowels on low/mid energy.
  if (highRatio > 0.38) return { viseme: 'viseme_SS', level: level * 0.8 };
  if (highRatio > 0.28) return { viseme: 'viseme_FF', level: level * 0.7 };
  if (highRatio > 0.22 && midRatio > highRatio) return { viseme: 'viseme_TH', level: level * 0.7 };

  // Voiced frames: pick a vowel shape from the low/mid balance.
  // Low-dominant -> rounded (O/U), mid-dominant -> open (aa), else front (E/I).
  if (low / total > 0.55) {
    return { viseme: midRatio < 0.3 ? 'viseme_U' : 'viseme_O', level };
  }
  if (midRatio > 0.45) {
    return { viseme: highRatio > 0.15 ? 'viseme_E' : 'viseme_aa', level };
  }
  return { viseme: 'viseme_aa', level };
}
