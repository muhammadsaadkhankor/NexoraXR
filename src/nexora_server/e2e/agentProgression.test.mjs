// E2E: V2 server-driven lecture progression — real Socket.IO server.
// Verifies the ProfessorAgent sequences one unit at a time, completion reports
// advance exactly once, floor pauses gate progression, and dynamic-utterance
// failure falls back to prepared segments.
//
// OLLAMA is pointed at a dead port so speak_dynamic units deterministically
// fail -> fallback path (opening -> segment 0). The happy dynamic path is
// covered by agent/utterance unit tests.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(
  new URL('../../nexora_client/package.json', import.meta.url)
);
const { io: ioClient } = require('socket.io-client');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3998;
const BASE = `http://localhost:${PORT}`;
const LID = 'Lecture_1';
const SEG_COUNT = 10; // Lecture_1 manifest length (10 curated segments)
let server;

before(async () => {
  server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env, PORT: String(PORT),
      // Dead endpoints: LLM/TTS calls fail fast -> deterministic fallback path.
      OLLAMA_BASE_URL: 'http://127.0.0.1:9',
      VOXCPM_BASE_URL: 'http://127.0.0.1:9',
    },
    stdio: 'ignore',
  });
  for (let i = 0; i < 60; i++) {
    try {
      await fetch(`${BASE}/api/rooms/public`);
      return;
    } catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  throw new Error('server did not start');
});

after(() => { server?.kill('SIGKILL'); });

const connect = () => new Promise((res, rej) => {
  const s = ioClient(BASE, { transports: ['websocket'], reconnection: false });
  s.on('connect', () => res(s));
  s.on('connect_error', rej);
});

const join = (s, roomId, pid) => s.emit('join', {
  roomId, name: 'User', participantId: pid,
});

const waitFor = (s, event, pred = () => true, ms = 8000) =>
  new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`timeout waiting for '${event}'`)), ms);
    const h = (d) => { if (pred(d)) { clearTimeout(t); s.off(event, h); res(d); } };
    s.on(event, h);
  });

const nextSegment = (s, n) =>
  waitFor(s, 'professor-speak', (d) => d?.type === 'lecture' && d.id === `${LID}_seg_${n}`);

const endReport = (s, n) =>
  s.emit('lecture-segment-ended', { lectureId: LID, segmentId: n, messageId: `${LID}_seg_${n}` });

// Report every lecture unit's completion — including dynamic units (_dyn_N)
// that may appear when the utterance cache is warm. Duplicates are harmless
// (server matches messageId against the in-flight unit).
function autoPlayer(s, extra = () => {}) {
  s.on('professor-speak', (d) => {
    if (d?.type !== 'lecture' || !d.id) return;
    extra(d);
    const m = /^(.+)_seg_(\d+)$/.exec(d.id);
    setTimeout(() => s.emit('lecture-segment-ended', {
      lectureId: d.lectureId || (m ? m[1] : LID),
      segmentId: m ? Number(m[2]) : null,
      messageId: d.id,
    }), 5);
  });
}

test('single client: server sequences 0..9 then lecture-complete', async () => {
  const s = await connect();
  join(s, 'e2e-prog-1', 'p1');
  await waitFor(s, 'session.snapshot');
  autoPlayer(s);
  s.emit('lecture.start', { lectureId: LID });

  for (let n = 0; n < SEG_COUNT; n++) {
    const seg = await nextSegment(s, n);
    assert.equal(seg.type, 'lecture');
    assert.ok(seg.text.length > 0);
    assert.equal(seg.id, `${LID}_seg_${n}`);
    // Duplicate/stale report for a previous segment must be ignored.
    if (n > 0) endReport(s, n - 1);
    endReport(s, n);
  }
  const done = await waitFor(s, 'lecture-complete');
  // Dead LLM: opening/transitions fall back to segments, closing_recap failure
  // ends the lecture safely — 'utterance_failed' is the closing-fallback reason.
  assert.ok(['lecture_complete', 'utterance_failed'].includes(done.reason));
  s.close();
});

test('duplicate completion reports do not double-advance', async () => {
  const s = await connect();
  join(s, 'e2e-prog-2', 'p2');
  await waitFor(s, 'session.snapshot');
  autoPlayer(s);
  s.emit('lecture.start', { lectureId: LID });
  await nextSegment(s, 0);
  // Fire the same completion three times — exactly one advance may happen.
  endReport(s, 0); endReport(s, 0); endReport(s, 0);
  await nextSegment(s, 1);
  // The lecture continues (autoPlayer), but seg_0/seg_1 must never repeat.
  const extra = [];
  s.on('professor-speak', (d) => d?.type === 'lecture' && extra.push(d.id));
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(!extra.includes(`${LID}_seg_0`), 'seg_0 replayed');
  assert.ok(!extra.includes(`${LID}_seg_1`), 'seg_1 duplicated by duplicate reports');
  s.close();
});

test('two clients: identical stream, duplicate room reports advance once', async () => {
  const a = await connect();
  const b = await connect();
  join(a, 'e2e-prog-3', 'pa');
  join(b, 'e2e-prog-3', 'pb');
  await waitFor(a, 'session.snapshot');
  await waitFor(b, 'session.snapshot');
  autoPlayer(a);
  autoPlayer(b);
  a.emit('lecture.start', { lectureId: LID });

  const [segA0, segB0] = await Promise.all([nextSegment(a, 0), nextSegment(b, 0)]);
  assert.equal(segA0.id, segB0.id);
  assert.equal(segA0.text, segB0.text);

  // BOTH clients report the same segment end — only one advance allowed.
  endReport(a, 0); endReport(b, 0);
  const [segA1, segB1] = await Promise.all([nextSegment(a, 1), nextSegment(b, 1)]);
  assert.equal(segA1.id, `${LID}_seg_1`);
  assert.equal(segB1.id, `${LID}_seg_1`);
  a.close(); b.close();
});

test('floor pause gates progression; resume re-arms it', async () => {
  const s = await connect();
  join(s, 'e2e-prog-4', 'p4');
  await waitFor(s, 'session.snapshot');
  // Auto-complete any dynamic units (opening) so the room reaches seg_0;
  // segment completion is driven manually below for pause-gate control.
  s.on('professor-speak', (d) => {
    if (d?.id?.includes('_dyn_')) {
      setTimeout(() => s.emit('lecture-segment-ended',
        { lectureId: d.lectureId || LID, messageId: d.id }), 5);
    }
  });
  s.emit('lecture.start', { lectureId: LID });
  await nextSegment(s, 0);

  s.emit('request-floor');
  await waitFor(s, 'lecture-control', (d) => d?.action === 'pause-for-floor');
  // Holder reports its checkpoint (floor-ready); segment end during PAUSED
  // must NOT advance the agent.
  s.emit('lecture-checkpoint', {
    lectureId: LID, language: 'en', segmentIndex: 0, playbackOffsetMs: 5000,
  });
  endReport(s, 0);
  const premature = [];
  s.on('professor-speak', (d) => d?.type === 'lecture' && premature.push(d.id));
  await new Promise((r) => setTimeout(r, 400));
  assert.deepEqual(premature, []);

  // Release the floor without a question — lecture resumes, then the same
  // segment finishing advances the room to seg_1.
  s.emit('release-floor');
  await waitFor(s, 'lecture-control', (d) => d?.action === 'resume');
  endReport(s, 0);
  await nextSegment(s, 1);
  s.close();
});

test('opening emitted at most once; segment 0 always follows', async () => {
  const s = await connect();
  join(s, 'e2e-prog-6', 'p6');
  await waitFor(s, 'session.snapshot');
  const seen = [];
  autoPlayer(s, (d) => seen.push(d.id));
  s.emit('lecture.start', { lectureId: LID });
  // Dead Ollama -> opening falls back to seg_0; a warm utterance cache may
  // instead serve a real opening — either way the invariant is identical.
  await nextSegment(s, 0);
  const dyns = seen.filter((id) => id.includes('_dyn_'));
  assert.ok(dyns.length <= 1, `expected <=1 dynamic unit before seg_0, got ${dyns.length}`);
  assert.equal(seen.at(-1), `${LID}_seg_0`);
  s.close();
});

test('snapshot exposes lectureProgress after agent advance', async () => {
  const s = await connect();
  join(s, 'e2e-prog-5', 'p5');
  await waitFor(s, 'session.snapshot');
  autoPlayer(s);
  s.emit('lecture.start', { lectureId: LID });
  await nextSegment(s, 0);
  endReport(s, 0);
  await nextSegment(s, 1);
  s.emit('session.sync');
  const snap = await waitFor(s, 'session.snapshot', (d) => d?.lectureProgress?.currentSegmentId === 1);
  assert.equal(snap.lectureProgress.lectureId, LID);
  assert.equal(snap.lectureProgress.currentSegmentId, 1);
  assert.equal(snap.lectureProgress.currentTopicId, 't1');
  s.close();
});
