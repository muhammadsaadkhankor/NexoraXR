// E2E: private-room host pause vs. social channels — real Socket.IO server.
// Verifies professor playback and human interaction (voice signaling, chat,
// presence) are independent concerns during host pause/resume/end.
//
// Run: npm run test:e2e   (needs the nexora_client socket.io-client package)
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
const PORT = 3999;
const BASE = `http://localhost:${PORT}`;
let server;

before(async () => {
  server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore',
  });
  // wait for the port to accept connections
  for (let i = 0; i < 60; i++) {
    try {
      await fetch(`${BASE}/api/rooms/public`);
      return;
    } catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  throw new Error('server did not start');
});

after(() => { server?.kill('SIGKILL'); });

const connect = (name) => new Promise((res, rej) => {
  const s = ioClient(BASE, { transports: ['websocket'], reconnection: false });
  s.on('connect', () => res(s));
  s.on('connect_error', rej);
});

const emitJoin = (s, data) => s.emit('join', {
  name: 'User', participantId: data.participantId, ...data,
});

const waitFor = (s, event, pred = () => true, ms = 5000) =>
  new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`timeout waiting for '${event}'`)), ms);
    const h = (d) => { if (pred(d)) { clearTimeout(t); s.off(event, h); res(d); } };
    s.on(event, h);
  });

const never = (s, event, pred = () => true, ms = 400) =>
  new Promise((res, rej) => {
    const t = setTimeout(res, ms);
    const h = (d) => { if (pred(d)) { clearTimeout(t); rej(new Error(`unexpected '${event}'`)); } };
    s.on(event, h);
  });

async function createPrivate() {
  const r = await fetch(`${BASE}/api/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      className: 'E2E Room', courseId: 'Multimedia', lectureId: 'Lecture_1',
      language: 'en', roomType: 'private', hostId: 'host-pid', scene: 'Multimedia',
    }),
  });
  assert.equal(r.status, 201);
  return r.json();
}

test('A–H: social channels stay live across host pause/resume/end/reconnect', async (t) => {
  const { roomId, inviteUrl } = await createPrivate();
  const invite = new URL(`http://x${inviteUrl}`).searchParams.get('invite');

  // --- host joins (bypasses approval), guest requests + gets approved -------
  const host = await connect();
  emitJoin(host, { room: roomId, invite, participantId: 'host-pid', name: 'Host' });
  const hostSnap = await waitFor(host, 'session.snapshot');
  assert.equal(hostSnap.room.roomId, roomId);
  assert.equal(hostSnap.room.roomType, 'private');
  assert.equal(hostSnap.room.hostId, 'host-pid');

  const guest = await connect();
  emitJoin(guest, { room: roomId, invite, participantId: 'guest-pid', name: 'Guest' });
  const [req, , guestSnap] = await Promise.all([
    waitFor(host, 'private-join-request'),
    waitFor(guest, 'join-pending'),
    (async () => {
      // approve after the request lands — sequenced below via req
      return null;
    })(),
  ]);
  host.emit('private-join-decision', { socketId: req.socketId, accept: true });
  const gsnap = await waitFor(guest, 'session.snapshot');
  assert.equal(gsnap.room.roomId, roomId);
  assert.equal(gsnap.canCatchUp, false); // private rooms: no recap

  // --- A: host starts lecture; guest receives the same professor segment ----
  const segHead = { id: 'Lecture_1_seg_2', type: 'lecture', text: 'seg two', audioUrl: null };
  const guestHears = waitFor(guest, 'professor-speak', (m) => m.id === 'Lecture_1_seg_2');
  host.emit('professor-speak', segHead);
  await guestHears;

  // guest's own playback report must NOT reach the room (host-only control)
  const hostShouldNotHear = never(host, 'professor-speak', (m) => m.id === 'Lecture_1_seg_5');
  guest.emit('professor-speak', { id: 'Lecture_1_seg_5', type: 'lecture', text: 'x' });
  await hostShouldNotHear;

  // --- social: chat + webrtc relay work during normal lecturing -------------
  const hostChat = waitFor(host, 'chat', (c) => c.text === 'hello host');
  guest.emit('chat', { text: 'hello host', name: 'Guest' });
  await hostChat;

  const hostSignal = waitFor(host, 'webrtc-signal', (m) => m.from === 'guest-pid');
  guest.emit('webrtc-signal', { to: 'host-pid', data: { type: 'offer', sdp: 'x' } });
  await hostSignal;

  // avatar position sync unaffected
  const hostSeesMove = waitFor(host, 'state-update', (u) => u.userId === 'guest-pid');
  guest.emit('state-update', { position: [1, 0, 0], rotation: [0, 0, 0], animation: 'Walk' });
  await hostSeesMove;

  // --- B: host pauses for discussion ---------------------------------------
  const hostPause = waitFor(host, 'lecture-control', (d) => d.action === 'pause-for-host');
  const guestPause = waitFor(guest, 'lecture-control', (d) => d.action === 'pause-for-host');
  host.emit('lecture-control', { action: 'pause' });
  await Promise.all([hostPause, guestPause]);

  // guest pause attempt is rejected without touching room state
  const guestErr = waitFor(guest, 'lecture-control', (d) => d.action === 'control-error');
  guest.emit('lecture-control', { action: 'pause' });
  await guestErr;

  // --- C: during host pause — chat/voice bidirectional, hand disabled -------
  const gChat = waitFor(guest, 'chat', (c) => c.text === 'still works');
  host.emit('chat', { text: 'still works', name: 'Host' });
  await gChat;

  const gSignal = waitFor(guest, 'webrtc-signal', (m) => m.from === 'host-pid');
  host.emit('webrtc-signal', { to: 'guest-pid', data: { type: 'offer', sdp: 'y' } });
  await gSignal;

  // raise-hand is a no-op while host-paused: no floor pause issued
  const noFloorPause = never(guest, 'lecture-control', (d) => d.action === 'pause-for-floor');
  guest.emit('request-floor');
  await noFloorPause;

  // position updates still flow while paused (avatars stay live)
  const gMove = waitFor(guest, 'state-update', (u) => u.userId === 'host-pid');
  host.emit('state-update', { position: [2, 0, 0], rotation: [0, 0, 0], animation: 'Idle' });
  await gMove;

  // checkpoint frozen at the pause position (talking doesn't move it)
  host.emit('session.sync');
  const s1 = await waitFor(host, 'session.snapshot');
  assert.equal(s1.professor.status, 'PAUSED');
  assert.equal(s1.interruption.pauseReason, 'host');
  const cpSeg = s1.lecture.segmentIndex;

  // --- E: new approved guest joins while paused -----------------------------
  const rot = await fetch(`${BASE}/api/rooms/${roomId}/invite`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hostId: 'host-pid' }),
  }).then((r) => r.json());
  const invite2 = new URL(`http://x${rot.inviteUrl}`).searchParams.get('invite');
  const late = await connect();
  emitJoin(late, { room: roomId, invite: invite2, participantId: 'late-pid', name: 'Late' });
  const lateReq = await waitFor(host, 'private-join-request', (r) => r.name === 'Late');
  host.emit('private-join-decision', { socketId: lateReq.socketId, accept: true });
  const lateSnap = await waitFor(late, 'session.snapshot');
  assert.equal(lateSnap.professor.status, 'PAUSED');
  assert.equal(lateSnap.lecture.segmentIndex, cpSeg); // same checkpoint
  // fresh guest can immediately use voice signaling with existing members
  const hostHearsLate = waitFor(host, 'webrtc-signal', (m) => m.from === 'late-pid');
  late.emit('webrtc-signal', { to: 'host-pid', data: { type: 'offer', sdp: 'z' } });
  await hostHearsLate;

  // --- F: guest disconnects + reconnects during the pause -------------------
  guest.disconnect();
  await new Promise((r) => setTimeout(r, 300)); // within grace window
  const guest2 = await connect();
  // Reconnect with the same participantId: already-admitted members bypass the
  // (now dead) one-time invite — no token, no approval needed.
  emitJoin(guest2, { room: roomId, participantId: 'guest-pid', name: 'Guest' });
  const g2Snap = await waitFor(guest2, 'session.snapshot');
  assert.equal(g2Snap.professor.status, 'PAUSED'); // room stays paused
  assert.equal(g2Snap.interruption.pauseReason, 'host');
  // voice signaling path still works for the reconnected guest
  const hostHearsG2 = waitFor(host, 'webrtc-signal', (m) => m.from === 'guest-pid');
  guest2.emit('webrtc-signal', { to: 'host-pid', data: { type: 'offer', sdp: 're' } });
  await hostHearsG2;

  // --- G: host disconnects + reconnects — authority returns -----------------
  host.disconnect();
  await new Promise((r) => setTimeout(r, 300));
  const host2 = await connect();
  emitJoin(host2, { room: roomId, invite, participantId: 'host-pid', name: 'Host' });
  const h2Snap = await waitFor(host2, 'session.snapshot');
  assert.equal(h2Snap.room.hostId, 'host-pid');
  assert.equal(h2Snap.professor.status, 'PAUSED');

  // --- D: host resumes — everyone continues from the same checkpoint --------
  const gResume = waitFor(guest2, 'lecture-control', (d) => d.action === 'resume');
  const lResume = waitFor(late, 'lecture-control', (d) => d.action === 'resume');
  host2.emit('lecture-control', { action: 'resume' });
  const [gr, lr] = await Promise.all([gResume, lResume]);
  assert.equal(gr.checkpoint.segmentIndex, lr.checkpoint.segmentIndex);
  assert.equal(gr.checkpoint.playbackOffsetMs, lr.checkpoint.playbackOffsetMs);

  // social still alive after resume
  const stillChat = waitFor(late, 'chat', (c) => c.text === 'after resume');
  guest2.emit('chat', { text: 'after resume', name: 'Guest' });
  await stillChat;

  // --- H: host ends, restarts same lecture ----------------------------------
  const endBroadcast = waitFor(late, 'lecture-control', (d) => d.action === 'end');
  host2.emit('lecture-control', { action: 'end' });
  await endBroadcast;
  const lateHearsRestart = waitFor(late, 'professor-speak', (m) => m.id === 'Lecture_1_seg_0');
  host2.emit('professor-speak', { id: 'Lecture_1_seg_0', type: 'lecture', text: 'restart' });
  await lateHearsRestart;

  host2.disconnect(); guest2.disconnect(); late.disconnect();
});
