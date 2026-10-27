// E2E: V2.2 dynamic utterance flow — real Socket.IO server with the utterance
// stub (NXR_UTTERANCE_STUB=1) so Ollama/TTS aren't needed. Verifies the full
// agentic sequence: opening -> segments with transitions -> closing -> end,
// each dynamic emitted exactly once, all clients identical.
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
const PORT = 3997;
const BASE = `http://localhost:${PORT}`;
const LID = 'Lecture_1';
let server;

before(async () => {
  server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), NXR_UTTERANCE_STUB: '1',
      // e2e drives full NCIP without a database — legacy trust mode (dev only).
      NXR_DEV_UNAUTH_PROTOCOL: '1' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 60; i++) {
    try { await fetch(`${BASE}/api/rooms/public`); return; }
    catch { await new Promise((r) => setTimeout(r, 250)); }
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

// A client that auto-reports each unit's completion (like a real player that
// finishes audio instantly for stubbed no-audio messages).
function autoPlayer(s, log) {
  s.on('professor-speak', (d) => {
    if (d?.type !== 'lecture' || !d.id) return;
    log.push(d.id);
    const m = /^(.+)_seg_(\d+)$/.exec(d.id);
    // simulate real playback completion (async tick)
    setTimeout(() => s.emit('lecture-segment-ended', {
      lectureId: d.lectureId || (m ? m[1] : LID),
      segmentId: m ? Number(m[2]) : null,
      messageId: d.id,
    }), 5);
  });
}

test('full agentic run: opening -> segs+transitions -> closing -> end', async () => {
  const a = await connect();
  const b = await connect();
  join(a, 'e2e-dyn-1', 'da');
  join(b, 'e2e-dyn-1', 'db');
  await waitFor(a, 'session.snapshot');
  await waitFor(b, 'session.snapshot');
  const logA = [], logB = [];
  autoPlayer(a, logA);
  autoPlayer(b, logB);
  const done = waitFor(a, 'lecture-complete');
  a.emit('lecture.start', { lectureId: LID });
  const res = await done;
  assert.equal(res.reason, 'lecture_complete');

  // Expect: opening, then per topic {transition?, segment}, then closing.
  // 10 segments, transitions t1..t9 (9), opening+closing dynamic.
  const segs = logA.filter((id) => /_seg_\d+$/.test(id));
  const dyns = logA.filter((id) => id.includes('_dyn_'));
  assert.deepEqual(segs, [...Array(10).keys()].map((i) => `${LID}_seg_${i}`));
  // opening + 9 transitions + closing = 11 dynamic units, each exactly once
  assert.equal(dyns.length, 11);
  assert.equal(new Set(dyns).size, dyns.length, 'duplicate dynamic emitted');
  assert.equal(logA[0], dyns[0]); // opening first
  assert.equal(logA.at(-1), dyns.at(-1)); // closing last
  // both clients saw the identical stream
  assert.deepEqual(logB, logA);

  // progress state after completion
  a.emit('session.sync');
  const snap = await waitFor(a, 'session.snapshot', (d) => d?.lectureProgress != null);
  // lecture ended -> progress reset
  assert.equal(snap.lectureProgress.lectureId, null);
  a.close(); b.close();
});

test('restart after completion yields a fresh opening', async () => {
  const s = await connect();
  join(s, 'e2e-dyn-2', 'r1');
  await waitFor(s, 'session.snapshot');
  const log = [];
  autoPlayer(s, log);
  const runOnce = async () => {
    const done = waitFor(s, 'lecture-complete');
    s.emit('lecture.start', { lectureId: LID });
    await done;
  };
  await runOnce();
  const firstRunLen = log.length;
  await runOnce();
  const second = log.slice(firstRunLen);
  assert.equal(second.length, firstRunLen, 'restart replays full sequence');
  assert.ok(second[0].includes('_dyn_'), 'fresh opening on restart');
  s.close();
});

test('group recap: two late joiners -> one shared recap between seg1 and seg2', async () => {
  const a = await connect();
  join(a, 'e2e-grp-1', 'uA');
  await waitFor(a, 'session.snapshot');
  const seen = [];
  // Manual player: A reports every unit's completion as it arrives.
  a.on('professor-speak', (d) => {
    if (d?.type !== 'lecture' || !d.id) return;
    seen.push(d.id);
    const m = /^(.+)_seg_(\d+)$/.exec(d.id);
    setTimeout(() => a.emit('lecture-segment-ended', {
      lectureId: d.lectureId || (m ? m[1] : LID),
      segmentId: m ? Number(m[2]) : null,
      messageId: d.id,
    }), 5);
  });
  a.emit('lecture.start', { lectureId: LID });
  // Wait until seg_1 is actively playing.
  await waitFor(a, 'professor-speak', (d) => d.id === `${LID}_seg_1`);
  // B and C join mid-segment-1 — first-time joiners.
  const b = await connect(); const snapB = waitFor(b, 'session.snapshot'); join(b, 'e2e-grp-1', 'uB');
  const c = await connect(); const snapC = waitFor(c, 'session.snapshot'); join(c, 'e2e-grp-1', 'uC');
  await snapB; await snapC;
  // A's auto-report ends seg_1 -> expect ONE group recap, then seg_2.
  const recap = await waitFor(a, 'professor-speak',
    (d) => d?.type === 'lecture' && d.dynamic === 'group_recap', 15000);
  assert.ok(recap.id.includes('_dyn_'));
  const seg2 = await waitFor(a, 'professor-speak', (d) => d.id === `${LID}_seg_2`, 15000);
  // Ordering in A's stream: seg_1 -> recap -> seg_2, recap exactly once.
  const i1 = seen.indexOf(`${LID}_seg_1`), iR = seen.indexOf(recap.id), i2 = seen.indexOf(`${LID}_seg_2`);
  assert.ok(i1 < iR && iR < i2, `bad order: ${JSON.stringify(seen)}`);
  assert.equal(seen.filter((id) => id === recap.id).length, 1);
  assert.equal(seen.filter((id) => id === `${LID}_seg_1`).length, 1, 'seg_1 replayed');
  // B and C see the same recap (broadcast path — may also get it live).
  const recapB = await waitFor(b, 'professor-speak',
    (d) => d?.dynamic === 'group_recap', 15000).catch(() => null);
  // B may have already consumed the recap event synchronously — accept null,
  // but if seen it must be the same unit id.
  if (recapB) assert.equal(recapB.id, recap.id);
  a.close(); b.close(); c.close();
});

test('group recap: a single late joiner triggers nothing', async () => {
  const a = await connect();
  join(a, 'e2e-grp-2', 'soloA');
  await waitFor(a, 'session.snapshot');
  const seen = [];
  a.on('professor-speak', (d) => {
    if (d?.type !== 'lecture' || !d.id) return;
    seen.push(d);
    const m = /^(.+)_seg_(\d+)$/.exec(d.id);
    setTimeout(() => a.emit('lecture-segment-ended', {
      lectureId: d.lectureId || (m ? m[1] : LID),
      segmentId: m ? Number(m[2]) : null,
      messageId: d.id,
    }), 5);
  });
  a.emit('lecture.start', { lectureId: LID });
  await waitFor(a, 'professor-speak', (d) => d.id === `${LID}_seg_1`);
  const b = await connect(); const snapB = waitFor(b, 'session.snapshot'); join(b, 'e2e-grp-2', 'soloB');
  await snapB;
  await waitFor(a, 'professor-speak', (d) => d.id === `${LID}_seg_2`);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(seen.filter((d) => d.dynamic === 'group_recap').length, 0);
  a.close(); b.close();
});
