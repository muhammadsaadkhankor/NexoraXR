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

function refAudioForVoice(voiceId) {
  const registry = loadRegistry();
  const wav = registry[voiceId]?.prompt_wav
    || registry[VOXCPM_VOICE_ID]?.prompt_wav
    || Object.values(registry)[0]?.prompt_wav;
  if (wav && fs.existsSync(wav)) return `file://${wav}`;
  const envRef = process.env.VOXCPM_REF_WAV;
  return envRef ? `file://${envRef}` : null;
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

export async function synthesize(text, voiceId) {
  const body = {
    model: VOXCPM_MODEL,
    input: text,
    voice: 'default',
    response_format: 'wav',
    stream: false,
  };
  const refAudio = refAudioForVoice(voiceId || VOXCPM_VOICE_ID);
  if (refAudio) body.ref_audio = refAudio;

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
