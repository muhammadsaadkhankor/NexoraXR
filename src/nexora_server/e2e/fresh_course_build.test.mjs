// E2E: fresh-course full build — create a brand-new course from ONE PDF,
// drive it through the real pipeline (ingest → scripts → approve →
// translations + audio bake ×6 languages + utterances) and verify the
// build reaches 'ready' with every lecture allReady in all six languages.
//
// Runs against a spawned backend with REAL services (Ollama, VoxCPM,
// pdftoppm, real DB). Auth: a session row is minted directly for the
// SUPER_ADMIN account — this is a test convenience only.
//
// Usage:
//   node e2e/fresh_course_build.test.mjs <run#> [pdfPath] [serverPort]
// Prints a JSON result line at the end:
//   RESULT {"run":1,"courseId":"…","lectureId":"gen_…","roomId":"…","ready":true,"secs":1234}
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUN = Number(process.argv[2] || 1);
const PDF = process.argv[3] || '/home/msaad/Downloads/Lec1_Introduction.pdf';
const PORT = Number(process.argv[4] || 3010);
const BASE = `http://localhost:${PORT}`;
const DATABASE_URL = process.env.DATABASE_URL
  || 'postgres://postgres:postgres@localhost:5433/nexoraxr';
const ADMIN_ID = '91a9c76a-49e1-4b05-bd27-529078b00701';
const t0 = Date.now();
const lap = (label) => console.log(`[${String((Date.now() - t0) / 1000 | 0).padStart(5)}s] ${label}`);

// ---- spawn backend ----------------------------------------------------------
const server = spawn(process.execPath, ['server.js'], {
  cwd: path.join(__dirname, '..'),
  env: {
    ...process.env, PORT: String(PORT), DATABASE_URL,
    // Real services — never inherit stubbed endpoints from a test shell.
    VOXCPM_BASE_URL: 'http://localhost:8010',
    OLLAMA_BASE_URL: 'http://localhost:11434',
    NXR_DEV_UNAUTH_PROTOCOL: '1',
    NXR_REPAIR_ON_BOOT: '0', // time the build, not the backfill
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const srvLog = [];
server.stdout.on('data', (d) => { srvLog.push(String(d)); process.stdout.write(`[srv] ${d}`); });
server.stderr.on('data', (d) => { srvLog.push(String(d)); process.stderr.write(`[srv] ${d}`); });
process.on('exit', () => server.kill('SIGKILL'));

process.env.DATABASE_URL = DATABASE_URL;
const { initDb, getPool } = await import('../db/pool.mjs');
await initDb(null, { migrate: false });
// Mint a session token directly (test-only shortcut).
const token = 'e2e_' + randomBytes(32).toString('hex');
await getPool().query(
  `INSERT INTO auth_sessions (id, user_id, token_hash, expires_at)
   VALUES ($1,$2,$3, now() + interval '6 hours')`,
  [randomUUID(), ADMIN_ID, createHash('sha256').update(token).digest('hex')]);
const AUTH = { 'Content-Type': 'application/json', Cookie: `nxr_session=${token}` };
const api = async (m, p, body) => {
  const r = await fetch(`${BASE}${p}`, { method: m, headers: AUTH,
    body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, ...d };
};

for (let i = 0; i < 120; i++) {
  try { if ((await fetch(`${BASE}/api/rooms/public`)).ok) break; }
  catch { }
  await new Promise((r) => setTimeout(r, 500));
  if (i === 119) { console.error('server did not start'); process.exit(1); }
}
lap('server up');

// ---- create course + room + upload ------------------------------------------
const name = `E2E Fresh Course ${RUN} ${new Date().toISOString().slice(11, 19)}`;
const { course } = await api('POST', '/api/courses', { name });
if (!course?.id) { console.error('course create failed'); process.exit(1); }
const { roomId } = await api('POST', '/api/rooms', {
  className: name, courseName: name, courseId: course.id,
  roomType: 'private', lectureCount: 1 });
if (!roomId) { console.error('room create failed'); process.exit(1); }
lap(`course ${course.id} room ${roomId}`);

const pdfBuf = fs.readFileSync(PDF);
const up = await api('POST', `/api/rooms/${roomId}/materials`, {
  files: [{ name: path.basename(PDF), dataUrl: `data:application/pdf;base64,${pdfBuf.toString('base64')}` }],
});
if (!up.ok) { console.error('upload failed', up); process.exit(1); }
lap('pdf uploaded');

// ---- plan preview → build ----------------------------------------------------
let preview = null;
for (let i = 0; i < 120; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  preview = await api('GET', `/api/courses/${course.id}/plan-preview`);
  if (preview?.failed?.length) { console.error('ingest failed', preview.failed); process.exit(1); }
  if (preview?.lectures?.length >= 1) break;
}
if (!preview?.lectures?.length) { console.error('no plan', preview); process.exit(1); }
lap(`plan: ${preview.lectures.map((l) => l.title).join(' | ')}`);

const b = await api('POST', `/api/courses/${course.id}/build`, {
  lectureCount: 1, lecturePlan: preview.lectures, minutes: 10 });
if (!b.ok && !b.buildId) { console.error('build start failed', b); process.exit(1); }

// Poll to the script-review gate, then approve audio — programmatically,
// exactly what the modal's single button does.
// Every wait has a NO-PROGRESS watchdog: if neither status, stage nor
// progress changes for STALL_MIN minutes, stop and report instead of
// polling forever. A 'failed' build reports its per-segment detail and
// terminates immediately — a build parked for instructor review can never
// be satisfied by waiting.
const STALL_MIN = Number(process.env.E2E_STALL_MIN || 10);
const poll = async (want, label, timeoutMin = 90) => {
  let lastSig = null, lastChange = Date.now();
  for (let i = 0; i < timeoutMin * 20; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const st = await api('GET', `/api/courses/${course.id}/status`);
    const step = st?.build?.status;
    const sig = `${step}|${st?.build?.stats?.stage || ''}|${st?.build?.stats?.progress || ''}`;
    if (sig !== lastSig) { lastSig = sig; lastChange = Date.now(); lap(`${label}: ${sig}`); }
    else if (i % 20 === 0) lap(`${label}: ${sig} (no change for ${((Date.now() - lastChange) / 60000).toFixed(1)} min)`);
    if (want === 'awaiting_review' && step === 'awaiting_review') return st;
    if (want === 'ready' && step === 'ready') return st;
    if (step === 'failed') {
      console.error(`BUILD FAILED: ${st.build?.error}`);
      await reportFailedSegments();
      return null;
    }
    // Parked at a review gate while we were waiting for 'ready' — that is
    // the instructor-repair path; no amount of waiting clears it.
    if (want === 'ready' && step === 'awaiting_review'
        && st?.build?.stats?.stage === 'translations') {
      console.error('BUILD PARKED for instructor review:', st.build?.error || st.build?.stats?.translation_errors);
      await reportFailedSegments();
      return null;
    }
    if (Date.now() - lastChange > STALL_MIN * 60_000) {
      console.error(`STALLED: no progress for ${STALL_MIN} min at "${sig}" — stopping.`);
      await reportFailedSegments();
      return null;
    }
  }
  console.error('timeout waiting for', want); return null;
};

// Exact failing segments per language, straight from the readiness endpoint.
async function reportFailedSegments() {
  const { rows: lecs } = await getPool().query(
    `SELECT lecture_id FROM course_lectures WHERE course_id=$1`, [course.id]).catch(() => ({ rows: [] }));
  for (const { lecture_id: lid } of lecs) {
    const rd = await api('GET', `/api/lecture/${lid}/readiness`);
    console.error(`  ${lid}: allReady=${rd.allReady} running=${rd.running}`);
    for (const [l, x] of Object.entries(rd.langs || {})) {
      console.error(`    ${l} segments ${x.readyCount}/${x.total} utterances ${x.utterances?.have}/${x.utterances?.expected}` +
        (x.missingSegments?.length ? ` missing:[${x.missingSegments.join(',')}]` : ''));
    }
    for (const f of (rd.failed || []).slice(0, 10)) {
      console.error(`    FAILED ${f.lang} seg ${f.idx}: en="${(f.enText || '').slice(0, 60)}…" translated=${f.langText ? `"${f.langText.slice(0, 60)}…"` : 'MISSING'}`);
    }
  }
}

const gate = await poll('awaiting_review', 'scripting', 30);
if (!gate) process.exit(1);
lap('scripts ready — approving audio (all 6 languages)');
const ap = await api('POST', `/api/courses/${course.id}/approve-audio`, {
  audioLangs: ['en', 'ar', 'fr', 'de', 'es', 'zh'] });
if (!ap.ok) { console.error('approve-audio refused', ap); process.exit(1); }

const done = await poll('ready', 'translating+baking', 60);
if (!done) process.exit(1);
lap('build READY');

// ---- verify: every lecture allReady in all six languages ---------------------
const { lectureReadiness } = await import('../protocol/languageReady.mjs');
const { bakeStatsSnapshot } = await import('../../nexora_ai/modules/bakeStats.mjs');
const { rows: lecs } = await getPool().query(
  `SELECT lecture_id FROM course_lectures WHERE course_id=$1`, [course.id]);
let allReady = true;
for (const { lecture_id: lid } of lecs) {
  const r = await lectureReadiness(lid);
  allReady = allReady && r.allReady;
  console.log(`READINESS ${lid} allReady=${r.allReady}`);
  for (const [l, x] of Object.entries(r.langs)) {
    console.log(`  ${l} segments ${x.readyCount}/${x.total} utterances ${x.utterances.have}/${x.utterances.expected} ${x.ready ? 'READY' : 'NOT'}`);
  }
  if (r.missing?.length) console.log('  missing:', r.missing.join(' | '));
}
console.log('BAKE_STATS', JSON.stringify(bakeStatsSnapshot()));
console.log(`RESULT ${JSON.stringify({ run: RUN, courseId: course.id,
  lectureIds: lecs.map((l) => l.lecture_id), roomId,
  ready: allReady, secs: Math.round((Date.now() - t0) / 1000) })}`);
server.kill('SIGKILL');
process.exit(allReady ? 0 : 1);
