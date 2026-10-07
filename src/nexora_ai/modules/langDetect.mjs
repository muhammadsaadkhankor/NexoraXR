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

const PY_SNIPPET = `import sys, whisper, warnings
warnings.filterwarnings('ignore')
m = whisper.load_model(${JSON.stringify(WHISPER_MODEL)})
print(whisper.load_audio and m.transcribe(sys.argv[1])["language"])
`;

// Returns the detected ISO language code ('en', 'ar', ...) or throws.
export async function detectLanguageFromWav(wavBuffer) {
  const tmp = path.join(
    os.tmpdir(),
    `tts_detect_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2)}.wav`
  );
  await fs.promises.writeFile(tmp, wavBuffer);
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(WHISPER_PYTHON, ['-c', PY_SNIPPET, tmp]);
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
        const detected = out.trim().split('\n').pop();
        if (code === 0 && detected) resolve(detected);
        else reject(new Error(`whisper detect failed (${code}): ${err.slice(-300)}`));
      });
    });
  } finally {
    fs.promises.unlink(tmp).catch(() => {});
  }
}
