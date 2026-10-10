// Whisper-based language verification for synthesized TTS audio. Runs the
// openai-whisper install in the `voxcpm` conda env; detection result is used
// ONLY to accept/reject the WAV — it never feeds back into room language.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WHISPER_PYTHON =
  process.env.WHISPER_PYTHON || `${process.env.HOME}/anaconda3/envs/voxcpm/bin/python`;
const WHISPER_MODEL = process.env.WHISPER_MODEL || 'base';
const DETECT_TIMEOUT_MS = Number(process.env.WHISPER_DETECT_TIMEOUT_MS) || 90_000;

// Windowed detection: slice the waveform into fixed windows INSIDE Python
// (one model load, numpy slicing at 16kHz) and transcribe each window. A
// mostly-Arabic clip with a Chinese blip still fails verification — the
// dominant-language check alone let mid-segment drift slip through.
const PY_SNIPPET_WINDOWED = `import sys, whisper, warnings
warnings.filterwarnings('ignore')
m = whisper.load_model(${JSON.stringify(WHISPER_MODEL)})
audio = whisper.load_audio(sys.argv[1])
sr = 16000
win = int(float(sys.argv[2]) * sr)
langs = []
for i in range(0, len(audio), win):
    chunk = audio[i:i + win]
    if len(chunk) < sr:  # skip <1s tail — too short to judge reliably
        break
    langs.append(m.transcribe(chunk)['language'])
print('\\n'.join(langs) if langs else 'unknown')
`;

const PY_SNIPPET = `import sys, whisper, warnings
warnings.filterwarnings('ignore')
m = whisper.load_model(${JSON.stringify(WHISPER_MODEL)})
print(whisper.load_audio and m.transcribe(sys.argv[1])["language"])
`;

function runWhisper(pythonArgs, tmp) {
  return new Promise((resolve, reject) => {
    const child = spawn(WHISPER_PYTHON, pythonArgs);
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('whisper language detection timed out'));
    }, DETECT_TIMEOUT_MS);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && out.trim()) resolve(out.trim());
      else reject(new Error(`whisper detect failed (${code}): ${err.slice(-300)}`));
    });
  });
}

async function withTmpWav(wavBuffer, fn) {
  const tmp = path.join(
    os.tmpdir(),
    `tts_detect_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2)}.wav`
  );
  await fs.promises.writeFile(tmp, wavBuffer);
  try {
    return await fn(tmp);
  } finally {
    fs.promises.unlink(tmp).catch(() => {});
  }
}

// Returns the detected ISO language code ('en', 'ar', ...) or throws.
export async function detectLanguageFromWav(wavBuffer) {
  return withTmpWav(wavBuffer, async (tmp) => {
    const out = await runWhisper(['-c', PY_SNIPPET, tmp], tmp);
    return out.split('\n').pop();
  });
}

// Returns an array of per-window ISO codes (e.g. ['ar','ar','zh']) or throws.
// windowSec defaults to 3s — VoxCPM2 can drift for only a couple of seconds,
// and a 5s window hides a sub-window blip inside the dominant language.
export async function detectLanguagesWindowed(wavBuffer, windowSec = 3) {
  return withTmpWav(wavBuffer, async (tmp) => {
    const out = await runWhisper(['-c', PY_SNIPPET_WINDOWED, tmp, String(windowSec)], tmp);
    return out.split('\n').map((l) => l.trim()).filter(Boolean);
  });
}
