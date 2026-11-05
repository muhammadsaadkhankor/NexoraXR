// Whisper-based language verification for synthesized TTS audio. Runs the
// openai-whisper install in the `voxcpm` conda env; detection result is used
// ONLY to accept/reject the WAV — it never feeds back into room language.
//
// The model is loaded ONCE by a persistent helper process
// (whisper_service.py) — previously every clip spawned a fresh Python
// interpreter and paid the full model-load cost. Requests are serialized
// over stdin/stdout JSON lines; if the service cannot start or dies, calls
// fall back to the legacy per-clip spawn so detection keeps working.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WHISPER_PYTHON =
  process.env.WHISPER_PYTHON || `${process.env.HOME}/anaconda3/envs/voxcpm/bin/python`;
const WHISPER_MODEL = process.env.WHISPER_MODEL || 'base';
const DETECT_TIMEOUT_MS = Number(process.env.WHISPER_DETECT_TIMEOUT_MS) || 90_000;
const SERVICE_SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)), 'whisper_service.py');
// Set WHISPER_NO_SERVICE=1 to force the legacy per-clip spawn path.
const USE_SERVICE = process.env.WHISPER_NO_SERVICE !== '1';

// Legacy per-clip fallback snippets (model loaded inside Python each call).
const PY_SNIPPET_WINDOWED = `import sys, whisper, warnings
warnings.filterwarnings('ignore')
try:
    m = whisper.load_model(${JSON.stringify(WHISPER_MODEL)})
except Exception:
    m = whisper.load_model(${JSON.stringify(WHISPER_MODEL)}, device='cpu')
audio = whisper.load_audio(sys.argv[1])
sr = 16000
win = int(float(sys.argv[2]) * sr)
langs = []
for i in range(0, len(audio), win):
    chunk = audio[i:i + win]
    if len(chunk) < sr:  # skip <1s tail — too short to judge reliably
        break
    # Encoder-only language classification: detect_language on the mel of the
    # 30s-padded window. ~10x cheaper than transcribe() (no text decode), so a
    # larger model fits the detection timeout — and the classifier score is a
    # direct language probability rather than a transcription side effect.
    mel = whisper.log_mel_spectrogram(whisper.pad_or_trim(chunk)).to(m.device)
    _, probs = m.detect_language(mel)
    langs.append(max(probs, key=probs.get))
print('\\n'.join(langs) if langs else 'unknown')
`;

const PY_SNIPPET = `import sys, whisper, warnings
warnings.filterwarnings('ignore')
m = whisper.load_model(${JSON.stringify(WHISPER_MODEL)})
print(whisper.load_audio and m.transcribe(sys.argv[1])["language"])
`;

function runWhisper(pythonArgs) {
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

// ---- persistent service ---------------------------------------------------
// One child process, one model load. Requests are queued and answered in
// order — Whisper GPU work is not concurrency-safe so only one request is
// in flight at a time anyway.
const svc = {
  child: null,
  ready: false,
  broken: false,
  buffer: '',
  pending: null,       // {id, resolve, reject, timer}
  queue: [],           // waiting requests {req, resolve, reject}
  nextId: 0,
};

function svcSpawn() {
  if (svc.child || svc.broken) return;
  const child = spawn(WHISPER_PYTHON, [SERVICE_SCRIPT, WHISPER_MODEL], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  svc.child = child;
  svc.buffer = '';
  child.stdout.on('data', (d) => {
    svc.buffer += d;
    let idx;
    while ((idx = svc.buffer.indexOf('\n')) >= 0) {
      const line = svc.buffer.slice(0, idx).trim();
      svc.buffer = svc.buffer.slice(idx + 1);
      if (line.startsWith('ready')) {
        svc.ready = true;
        console.log(`[lang-detect] whisper service ready (${line.slice(6) || 'cuda'})`);
        svcFlush();
        continue;
      }
      if (!line) continue;
      let msg = null;
      try { msg = JSON.parse(line); } catch { continue; }
      const p = svc.pending;
      if (p && p.id === msg.id) {
        svc.pending = null;
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(`whisper service: ${msg.error}`));
        else p.resolve(msg.langs);
        svcFlush();
      }
    }
  });
  child.on('error', () => svcKill());
  child.on('close', () => {
    // Died mid-request or during startup — fail fast; callers fall back.
    svc.broken = true;
    svcKill();
  });
  process.on('exit', () => { try { svc.child?.kill('SIGKILL'); } catch {} });
}

function svcKill() {
  const p = svc.pending;
  svc.pending = null;
  if (p) { clearTimeout(p.timer); p.reject(new Error('whisper service died')); }
  const waiting = svc.queue.splice(0);
  for (const w of waiting) w.reject(new Error('whisper service died'));
  try { svc.child?.kill('SIGKILL'); } catch {}
  svc.child = null;
  svc.ready = false;
}

// Dispatch queued requests while the service is ready and idle.
function svcFlush() {
  if (!svc.ready || svc.pending || !svc.queue.length) return;
  const { req, resolve, reject } = svc.queue.shift();
  const timer = setTimeout(() => {
    svc.pending = null;
    reject(new Error('whisper service request timed out'));
    svcFlush();
  }, DETECT_TIMEOUT_MS);
  svc.pending = { id: req.id, resolve, reject, timer };
  try {
    svc.child.stdin.write(JSON.stringify(req) + '\n');
  } catch (e) {
    clearTimeout(timer);
    svc.pending = null;
    reject(e);
    svcFlush();
  }
}

function svcDetect(request) {
  return new Promise((resolve, reject) => {
    svcSpawn();
    if (!svc.child) return reject(new Error('whisper service unavailable'));
    svc.queue.push({ req: { id: ++svc.nextId, ...request }, resolve, reject });
    svcFlush();
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
    if (USE_SERVICE && !svc.broken) {
      try {
        const langs = await svcDetect({ path: tmp, mode: 'transcribe' });
        return langs[langs.length - 1];
      } catch { /* fall through to legacy spawn */ }
    }
    const out = await runWhisper(['-c', PY_SNIPPET, tmp]);
    return out.split('\n').pop();
  });
}

// Returns an array of per-window ISO codes (e.g. ['ar','ar','zh']) or throws.
// windowSec defaults to 3s — VoxCPM2 can drift for only a couple of seconds,
// and a 5s window hides a sub-window blip inside the dominant language.
export async function detectLanguagesWindowed(wavBuffer, windowSec = 3) {
  return withTmpWav(wavBuffer, async (tmp) => {
    if (USE_SERVICE && !svc.broken) {
      try {
        return await svcDetect({ path: tmp, window: windowSec });
      } catch { /* fall through to legacy spawn */ }
    }
    const out = await runWhisper(['-c', PY_SNIPPET_WINDOWED, tmp, String(windowSec)]);
    return out.split('\n').map((l) => l.trim()).filter(Boolean);
  });
}
