// E2E: language-switch reliability — fix/language-switch-reliability.
//
// Runs a REAL backend (dev-unauth, stub utterances, dead Ollama/VoxCPM —
// playback serves only pre-baked files) against the rehydrated public room.
//
// Assertions per the goal:
//  1. lecture.start is REFUSED with an exact reason for a lecture that is
//     not ready in all six languages (gen_957fc478_L1: ar 7/9, es 7/9,
//     de 8/9 segments + missing utterances).
//  2. A fully-ready lecture (gen_18b7cc52_L1) starts, then survives a
//     20-switch matrix covering all six languages >=3x each — every client
//     receives the same authoritative segmentIndex, and the segments served
//     for the new language point at that language's cache bucket.
//
// Usage: node src/nexora_server/e2e/langswitch_reliability.test.mjs
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(
  new URL('../../nexora_client/package.json', import.meta.url));
const { io: ioClient } = require('socket.io-client');
const { planLanguageSwitch } = await import(
  '../../nexora_client/src/classroom/services/ncipSync.js');

const PORT = Number(process.env.E2E_PORT || 3997);
const BASE = `http://localhost:${PORT}`;
const ROOM = process.env.E2E_ROOM || 'pub_b133789c047843fbce';
const HOST = process.env.E2E_HOST || '91a9c76a-49e1-4b05-bd27-529078b00701';
const READY_LID = 'gen_18b7cc52_L1';     // all 6 langs: 13/13 + utterances
const PARTIAL_LID = 'gen_957fc478_L1';   // ar/es/de incomplete
const DATABASE_URL = process.env.DATABASE_URL
  || 'postgres://postgres:postgres@localhost:5433/nexoraxr';

const server = spawn(process.execPath, ['server.js'], {
  cwd: path.join(__dirname, '..'),
  env: {
    ...process.env,
    PORT: String(PORT),
    NXR_DEV_UNAUTH_PROTOCOL: '1',
    NXR_UTTERANCE_STUB: '1',
    DATABASE_URL,
    OLLAMA_BASE_URL: 'http://127.0.0.1:9',
    VOXCPM_BASE_URL: 'http://127.0.0.1:9',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', (d) => process.stderr.write(`[srv] ${d}`));
process.on('exit', () => server.kill('SIGKILL'));

for (let i = 0; i < 80; i++) {
  try { await fetch(`${BASE}/api/rooms/public`); break; }
  catch { await new Promise((r) => setTimeout(r, 250)); }
  if (i === 79) { console.error('server did not start'); process.exit(1); }
}

const connect = () => new Promise((res, rej) => {
  const s = ioClient(BASE, { transports: ['websocket'], reconnection: false });
  s.on('connect', () => res(s));
  s.on('connect_error', rej);
});
const waitFor = (s, event, pred = () => true, ms = 15000) =>
  new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`timeout '${event}'`)), ms);
    const h = (d) => { if (pred(d)) { clearTimeout(t); s.off(event, h); res(d); } };
    s.on(event, h);
  });

const [host, s2] = await Promise.all([connect(), connect()]);
for (const [s, pid] of [[host, HOST], [s2, 'stu2']]) {
  s.emit('join', { roomId: ROOM, name: pid, participantId: pid });
}
await new Promise((r) => setTimeout(r, 800));

let failures = 0;
const check = (ok, label) => { console.log(`  ${ok ? 'PASS' : 'FAIL'} ${label}`); if (!ok) failures++; };

// ---- Assertion 1: start refused for an incompletely-baked lecture -----------
{
  const got = waitFor(host, 'lecture-control',
    (d) => d?.action === 'control-error', 15000);
  host.emit('lecture.start', { lectureId: PARTIAL_LID });
  const d = await got.catch(() => null);
  console.log(`\n[start gate] ${JSON.stringify(d?.error)}`);
  check(!!d && /Cannot start class/.test(d.error || ''),
    'lecture.start refused for incompletely-baked lecture');
  check(!!d && /AR: 7\/9/.test(d.error || ''), 'reason names AR 7/9 segments');
}

// ---- Assertion 2: switch matrix on the fully-ready lecture ------------------
host.on('professor-speak', (d) => {
  if (d?.type !== 'lecture' || !d.id || d.fromRemote) return;
  const m = /_seg_(\d+)$/.exec(d.id);
  if (m && Number(m[1]) >= 2) return; // park on seg 2 during the matrix
  setTimeout(() => host.emit('lecture-segment-ended',
    { lectureId: READY_LID, messageId: d.id }), 50);
});

host.emit('lecture.start', { lectureId: READY_LID });
const seg2 = await waitFor(host, 'professor-speak',
  (d) => d?.type === 'lecture' && /_seg_2$/.test(d.id || ''), 20000)
  .then(() => true).catch(() => false);
check(seg2, 'ready lecture starts and reaches segment 2');

// Fixed pseudo-random sequence: every language at least 3 times, covering
// fr->ar, ar->zh, zh->en and other tricky pairs.
const SEQ = ['fr', 'ar', 'zh', 'en', 'de', 'es', 'ar', 'fr', 'zh', 'es',
  'en', 'de', 'ar', 'zh', 'fr', 'es', 'de', 'en', 'zh', 'ar'];
const localQueues = {
  host: [{ id: `${READY_LID}_seg_2`, type: 'lecture' }],
  s2: [{ id: `${READY_LID}_seg_4`, type: 'lecture' }], // deliberately ahead
};

for (const lang of SEQ) {
  const waits = [host, s2].map((s) =>
    waitFor(s, 'lecture-control', (d) => d?.action === 'language-change', 12000)
      .then((d) => d).catch((e) => e));
  host.emit('language.change', { language: lang });
  const got = await Promise.all(waits);
  const idxs = got.map((g) => g.segmentIndex);
  const sameIdx = got.every((g) => !(g instanceof Error)) && new Set(idxs).size === 1;

  // The segments the clients would queue for the new language — audioUrl
  // must point at the language's own cache bucket.
  const manifest = await fetch(`${BASE}/api/lecture/segments/${READY_LID}?lang=${lang}`)
    .then((r) => r.json()).catch(() => null);
  const bucketOk = (manifest?.segments || [])
    .filter((s) => s.audioUrl)
    .every((s) => lang === 'en'
      ? s.audioUrl.includes(`/segment_audio/${READY_LID}/`)
      : s.audioUrl.includes(`/segment_audio/${READY_LID}__${lang}/`));
  const textOk = (manifest?.segments || []).every((s) => !s.pendingTranslation);

  const plans = [host, s2].map((_, i) =>
    planLanguageSwitch(Object.values(localQueues)[i], idxs[i])?.segmentIndex);
  const plansSame = sameIdx && plans.every((p) => p === idxs[0]);

  check(sameIdx && bucketOk && textOk && plansSame,
    `-> ${lang}: idx=${JSON.stringify(idxs)} bucket=${bucketOk ? 'ok' : 'WRONG'} text=${textOk ? 'ok' : 'PENDING'} plans=${JSON.stringify(plans)}`);
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} FAILURE(S)`);
server.kill('SIGKILL');
process.exit(failures === 0 ? 0 : 1);
