import { pcm16ToWav } from './audioUtils.mjs';

const COSYVOICE_URL = process.env.COSYVOICE_URL || 'http://localhost:5000';

export async function listVoices() {
  const res = await fetch(`${COSYVOICE_URL}/voices`);
  if (!res.ok) return [];
  const data = await res.json();
  const voices = Array.isArray(data) ? data : data.voices;
  return voices || [];
}

export async function getDefaultVoice(preferred = 'prof') {
  const voices = await listVoices();
  if (!voices.length) return null;
  if (typeof voices[0] === 'string') {
    return voices.find((v) => v === preferred) || voices[0];
  }
  const prof = voices.find((v) => v.voice_id === preferred);
  return prof ? prof.voice_id : voices[0].voice_id;
}

export async function synthesize(text, voiceId) {
  const form = new FormData();
  form.append('tts_text', text);
  form.append('voice_id', voiceId);
  form.append('stream', 'false');

  const res = await fetch(`${COSYVOICE_URL}/synthesize`, {
    method: 'POST',
    body: form,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`CosyVoice error: ${res.status} ${text}`);
  }

  const pcm = await res.arrayBuffer();
  if (pcm.byteLength === 0) throw new Error('CosyVoice returned empty audio');

  const wav = pcm16ToWav(pcm, 24000, 1);
  return Buffer.from(new Uint8Array(wav));
}
