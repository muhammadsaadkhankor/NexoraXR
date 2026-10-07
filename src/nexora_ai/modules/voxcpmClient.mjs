import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// VoxCPM2 TTS client — talks to the vLLM-Omni serving instance
// (`vllm serve openbmb/VoxCPM2 --omni`) via the OpenAI-compatible
// POST /v1/audio/speech endpoint. Voice cloning uses the ref_audio
// file:// URI resolved from the local voice registry.

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const VOXCPM_BASE_URL = (process.env.VOXCPM_BASE_URL || 'http://localhost:8010').replace(/\/$/, '');
const VOXCPM_VOICE_ID = process.env.VOXCPM_VOICE_ID || 'abed101';
const VOXCPM_MODEL = process.env.VOXCPM_MODEL || 'openbmb/VoxCPM2';

const REGISTRY_FILE = process.env.VOXCPM_VOICE_REGISTRY
  || path.join(__dirname, '..', '..', '..', 'voxcpm_data', 'voice_registry.json');

function loadRegistry() {
  try {
    return JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

// Resolve the reference pair for a voice, preferring a per-language entry
// (`<voiceId>_<lang>`, e.g. abed101_ar) when one is registered — a reference
// clip in the target language is the strongest conditioning VoxCPM2 offers,
// since the adapter ignores the request-level `language` field.
function refForVoice(voiceId, lang) {
  const registry = loadRegistry();
  const base = voiceId || VOXCPM_VOICE_ID;
  const entry = (lang && registry[`${base}_${lang}`])
    || registry[base]
    || registry[VOXCPM_VOICE_ID]
    || Object.values(registry)[0];
  let ref_audio = entry?.prompt_wav && fs.existsSync(entry.prompt_wav)
    ? `file://${entry.prompt_wav}`
    : null;
  if (!ref_audio && process.env.VOXCPM_REF_WAV) ref_audio = `file://${process.env.VOXCPM_REF_WAV}`;
  const ref_text = entry?.prompt_text || process.env.VOXCPM_REF_TEXT || null;
  return { ref_audio, ref_text };
}

export async function listVoices() {
  const registry = loadRegistry();
  return Object.keys(registry).map((voice_id) => ({ voice_id }));
}

export async function getDefaultVoice(preferred = VOXCPM_VOICE_ID) {
  const voices = await listVoices();
  if (!voices.length) return null;
  const prof = voices.find((v) => v.voice_id === preferred);
  return prof ? prof.voice_id : voices[0].voice_id;
}

// lang selects a per-language reference voice when registered and is included
// in the request body (`language` field — accepted by the OpenAI speech
// schema; the deployed VoxCPM2 adapter ignores it, but sending it is harmless
// and forward-compatible). Conditioning comes from ref_audio + ref_text.
export async function synthesize(text, voiceId, lang = null) {
  const body = {
    model: VOXCPM_MODEL,
    input: text,
    voice: 'default',
    response_format: 'wav',
    stream: false,
  };
  const { ref_audio, ref_text } = refForVoice(voiceId || VOXCPM_VOICE_ID, lang);
  if (ref_audio) body.ref_audio = ref_audio;
  if (ref_text) body.ref_text = ref_text;
  if (lang) body.language = lang;

  const res = await fetch(`${VOXCPM_BASE_URL}/v1/audio/speech`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`VoxCPM error: ${res.status} ${errText}`);
  }
  const wav = Buffer.from(await res.arrayBuffer());
  if (wav.length === 0) throw new Error('VoxCPM returned empty audio');
  return wav;
}

// Verified synthesis: VoxCPM2 language selection is implicit and stochastic,
// so non-English output is Whisper-checked against the expected language and
// retried. English is verified empirically stable — detection is skipped to
// avoid the extra latency. `opts.synthesize`/`opts.detect` are injectable for
// tests; the detection result is never propagated into room language state.
export async function synthesizeVerified(text, voiceId, lang, opts = {}) {
  const synth = opts.synthesize || synthesize;
  if (!lang || lang === 'en') {
    return synth(text, voiceId, lang);
  }
  const detect = opts.detect || (await import('./langDetect.mjs')).detectLanguageFromWav;
  const attempts = opts.attempts ?? 3; // 1 initial + 2 retries
  let lastError = null;
  for (let i = 0; i < attempts; i++) {
    const wav = await synth(text, voiceId, lang);
    const detected = await detect(wav);
    if (detected === lang) return wav;
    lastError = new Error(`TTS language mismatch: expected '${lang}', detected '${detected}'`);
  }
  throw lastError;
}
