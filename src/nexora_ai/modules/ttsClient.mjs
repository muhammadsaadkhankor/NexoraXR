import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { pcm16ToWav } from './audioUtils.mjs';

// stream-tts (nano-vllm VoxCPM2) client — talks to the FastAPI engine on
// :8000 (stream-tts/server/voxcpm_server.py). POST /generate streams raw
// s16le PCM @48 kHz; this client buffers it and wraps it in a WAV header
// so every downstream consumer sees the same complete-WAV contract the
// old vLLM-Omni client exposed.
//
// Voice cloning: reference clips are encoded ONCE via /encode_latents and
// the returned base64 latents are cached in memory and on disk under
// <registry dir>/.latents/<voice_id>.json (gitignored), keyed by the
// sha256 of the source prompt.wav so a changed clip re-encodes.

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TTS_URL = (process.env.TTS_URL || 'http://localhost:8000').replace(/\/$/, '');
const TTS_VOICE_ID = process.env.TTS_VOICE_ID || 'abed101';
const OUTPUT_SR = 48000; // engine native sample rate (VoxCPM2)

const REGISTRY_FILE = process.env.TTS_VOICE_REGISTRY
  || path.join(__dirname, '..', '..', '..', 'tts_voices', 'registry.json');
const REGISTRY_DIR = path.dirname(REGISTRY_FILE);
const LATENTS_DIR = path.join(REGISTRY_DIR, '.latents');

function loadRegistry() {
  try {
    return JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

const _latentsMem = new Map();    // cacheKey -> base64 latents
const _latentPending = new Map(); // cacheKey -> Promise (dedupe concurrent encodes)

// Resolve the reference entry for a voice, preferring a per-language entry
// (`<voiceId>_<lang>`, e.g. abed101_ar) when one is registered — a reference
// clip in the target language is the strongest conditioning available.
function refForVoice(voiceId, lang) {
  const registry = loadRegistry();
  const base = voiceId || TTS_VOICE_ID;
  const [key, entry] =
    (lang && registry[`${base}_${lang}`] && [`${base}_${lang}`, registry[`${base}_${lang}`]])
    || (registry[base] && [base, registry[base]])
    || (registry[TTS_VOICE_ID] && [TTS_VOICE_ID, registry[TTS_VOICE_ID]])
    || Object.entries(registry)[0]
    || [];
  let wavPath = entry?.prompt_wav
    ? (path.isAbsolute(entry.prompt_wav)
        ? entry.prompt_wav
        : path.join(REGISTRY_DIR, entry.prompt_wav))
    : null;
  if (wavPath && !fs.existsSync(wavPath)) wavPath = null;
  if (!wavPath && process.env.TTS_REF_WAV) wavPath = process.env.TTS_REF_WAV;
  const promptText = entry?.prompt_text || process.env.TTS_REF_TEXT || '';
  if (!wavPath) return null;
  return { key: key || '_envref', wavPath, promptText };
}

// Encode a voice's prompt.wav into engine latents (once per wav content).
async function latentsFor(key, wavPath) {
  if (_latentsMem.has(key)) return _latentsMem.get(key);
  if (_latentPending.has(key)) return _latentPending.get(key);
  const p = (async () => {
    const wavBuf = await fsp.readFile(wavPath);
    const sha = createHash('sha256').update(wavBuf).digest('hex');
    const cacheFile = path.join(LATENTS_DIR, `${key}.json`);
    try {
      const cached = JSON.parse(await fsp.readFile(cacheFile, 'utf-8'));
      if (cached.sha256 === sha && cached.latents) {
        _latentsMem.set(key, cached.latents);
        return cached.latents;
      }
    } catch { /* absent or stale — re-encode */ }
    const res = await fetch(`${TTS_URL}/encode_latents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wav_base64: wavBuf.toString('base64'), wav_format: 'wav' }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`TTS encode_latents error for '${key}': ${res.status} ${errText}`);
    }
    const { prompt_latents_base64: latents, sample_rate } = await res.json();
    await fsp.mkdir(LATENTS_DIR, { recursive: true });
    await fsp.writeFile(cacheFile, JSON.stringify({
      voice_id: key, sha256: sha, sample_rate,
      latents, encoded_at: new Date().toISOString(),
    }));
    _latentsMem.set(key, latents);
    return latents;
  })().finally(() => _latentPending.delete(key));
  _latentPending.set(key, p);
  return p;
}

export async function listVoices() {
  const registry = loadRegistry();
  return Object.keys(registry).map((voice_id) => ({ voice_id }));
}

export async function getDefaultVoice(preferred = TTS_VOICE_ID) {
  const voices = await listVoices();
  if (!voices.length) return null;
  const prof = voices.find((v) => v.voice_id === preferred);
  return prof ? prof.voice_id : voices[0].voice_id;
}

// lang selects a per-language reference voice when registered. The engine
// has no `language` parameter — output language is conditioned by the
// target_text and the chosen voice latents.
export async function synthesize(text, voiceId, lang = null, opts = {}) {
  const body = { target_text: text, cfg_value: 2.0 };
  if (!opts.noRef) {
    const ref = refForVoice(voiceId || TTS_VOICE_ID, lang);
    if (ref) {
      const latents = await latentsFor(ref.key, ref.wavPath);
      // Same latents in both roles: prompt_latents+prompt_text give the
      // strongest same-voice conditioning; ref_audio covers the
      // cross-language conditioning path.
      body.prompt_latents_base64 = latents;
      body.prompt_text = ref.promptText;
      body.ref_audio_latents_base64 = latents;
    }
  }
  const res = await fetch(`${TTS_URL}/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`TTS error: ${res.status} ${errText}`);
  }
  const chunks = [];
  for await (const chunk of res.body) chunks.push(Buffer.from(chunk));
  const pcm = Buffer.concat(chunks);
  if (pcm.length === 0) throw new Error('TTS returned empty audio');
  return Buffer.from(pcm16ToWav(pcm, OUTPUT_SR, 1));
}

// Verified synthesis: TTS language selection is implicit and stochastic,
// so non-English output is Whisper-checked against the expected language and
// retried. English is verified empirically stable — detection is skipped to
// avoid the extra latency. `opts.synthesize`/`opts.detect` are injectable for
// tests; the detection result is never propagated into room language state.
export async function synthesizeVerified(text, voiceId, lang, opts = {}) {
  const synth = opts.synthesize || synthesize;
  if (!lang || lang === 'en') {
    return synth(text, voiceId, lang);
  }
  // Windowed detection catches mid-segment drift (e.g. an Arabic clip with a
  // few-second Chinese blip) that a dominant-language check would pass.
  // opts.detect may return a single code or an array of per-window codes.
  const detect = opts.detect || (await import('./langDetect.mjs')).detectLanguagesWindowed;
  const attempts = opts.attempts ?? 3; // 1 initial + 2 retries
  let lastError = null;
  for (let i = 0; i < attempts; i++) {
    const wav = await synth(text, voiceId, lang, opts.synthOpts || {});
    const detected = await detect(wav);
    // Windows are {lang, prob} (legacy detectors return bare codes → prob 1).
    const windows = (Array.isArray(detected) ? detected : [detected])
      .map((w) => (typeof w === 'string' ? { lang: w, prob: 1.0 } : w));
    // A confident foreign window (>=0.7) fails the clip outright — real drift.
    // A low-confidence off-language guess on a short intro/tail window is
    // detector noise (e.g. 'pl' at 0.48 on a 3s German greeting): it only
    // counts against the majority vote, not as a hard reject.
    const CONFIDENT = 0.7;
    // Confident-foreign windows get a transcribe second opinion — the
    // padded-window classifier is unreliable on short clips (clean es
    // openings labeled 'it' at 0.99; transcribe reads correct Spanish).
    // A window confirmed foreign BY TRANSCRIBE is real drift and fails.
    const second = opts.secondOpinion
      || (await import('./langDetect.mjs')).detectLanguageWindowTranscribe;
    for (let checked = 0; checked < 3; checked++) {
      const i = windows.findIndex((w) => w.lang !== lang && w.prob >= CONFIDENT);
      if (i === -1) break;
      try {
        const opinion = await second(wav, i * 3, 3);
        if (opinion === lang) windows[i] = { lang, prob: 0.5 };
        else if (opinion === 'unknown') windows[i] = { ...windows[i], prob: 0.5 };
        else break; // transcribe agrees it's foreign — keep the hard fail
      } catch { windows[i] = { ...windows[i], prob: 0.5 }; }
    }
    // Embedded proper-noun span (a course/title name in Title-Case mid-text,
    // e.g. "…mit dem Kurs E2E Fresh Course 1") legitimately SOUNDS foreign —
    // grant up to one tolerant window per ~5 name tokens, max 2.
    const nameTokens = (text.match(/(?<=\s)(?:[A-Z][\w-]*|\d+)(?:\s+(?:[A-Z][\w-]*|\d+))+/gu) || [])
      .reduce((s, m) => s + m.split(/\s+/).length, 0);
    const foreignAllowance = Math.min(2, Math.floor(nameTokens / 4));
    if (foreignAllowance > 0) {
      const foreignWindows = windows.filter((w) => w.lang !== lang && w.prob >= CONFIDENT);
      if (foreignWindows.length <= foreignAllowance) {
        for (const w of foreignWindows) w.prob = 0.5;
      }
    }
    const confidentForeign2 = windows.find((w) => w.lang !== lang && w.prob >= CONFIDENT);
    // Voting: target windows count fully; uncertain off-language guesses
    // (detector noise on short/borderline stretches) count half. A clip
    // passes when no confirmed-foreign window exists and the score clears
    // half the window count.
    const score = windows.reduce((s, w) =>
      s + (w.lang === lang ? 1 : (w.prob < CONFIDENT ? 0.5 : 0)), 0);
    const ok = !confidentForeign2 && score >= windows.length / 2;
    if (ok) return wav;
    console.warn(
      `[tts-verify] rejected lecture=${opts.lectureId ?? '?'} segment=${opts.segmentId ?? '?'} ` +
      `lang=${lang} attempt=${i + 1}/${attempts} windows=[${windows.map((w) => `${w.lang}@${w.prob}`).join(',')}]`);
    lastError = new Error(`TTS language mismatch: expected '${lang}', detected '${JSON.stringify(detected)}'`);
  }
  throw lastError;
}
