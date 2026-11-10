// Protocol driver for the resume-accuracy harness — a headless socket.io
// participant that joins the room, starts the lecture, and on each stdin
// 'hold' line plays the real holder flow: request-floor -> lecture-checkpoint
// (its own tracked segment + elapsed wall offset, sentenceIndex in 'en') ->
// floor-ready -> ask-floor-question -> resume. Emits one JSON event per line
// on stdout for the Python orchestrator.
import { createRequire } from 'node:module';
import readline from 'node:readline';

const require = createRequire(
  new URL('../../src/nexora_client/package.json', import.meta.url)
);
const { io } = require('socket.io-client');

const BASE = process.env.BASE || 'http://localhost:4120';
const ROOM = process.env.ROOM || 'eval-resume';
const PID = process.env.PID || 'holder';
const LECTURE = process.env.LECTURE || 'multimedia_L1';
const LANG = process.env.HOLDER_LANG || 'en';

const say = (ev, extra = {}) => console.log(JSON.stringify({ ev, ...extra }));

// EN manifest — for the holder's own sentenceIndex computation.
const manifest = await (await fetch(
  `${BASE}/api/lecture/segments/${LECTURE}?lang=${LANG}`
)).json();
const sentsBySeg = new Map(manifest.segments.map((s) => [s.id, s.sentences || []]));
const sentIdx = (seg, offSec) => {
  const sents = sentsBySeg.get(seg) || [];
  if (!sents.length || !Number.isFinite(offSec)) return null;
  let si = 0;
  for (let k = 0; k < sents.length; k++) {
    if ((sents[k].start ?? 0) <= offSec + 0.15) si = k;
  }
  return si;
};

let granted = false;
let awaitingResume = false;
let askDelayMs = 0; // hold the floor this long before asking (extra cases)
let lastSegIndex = null;
let lastSegAt = null; // wall ms when the current segment's speak broadcast arrived

// Reconnection enabled: a transient ws drop during the extras must not
// kill the driver for the rest of the cell — on reconnect we re-join with
// the same participantId (server treats it as a grace-window reconnect).
const s = io(BASE, { transports: ['websocket'] });
s.on('connect', () => {
  // passive: protocol driver without playback — must not block the
  // segment barrier.
  s.emit('join', { roomId: ROOM, name: PID, participantId: PID, passive: true });
});
s.on('disconnect', (reason) => say('socket-down', { reason }));
s.on('self-info', (d) => {
  if (d?.participantId === PID) say('joined');
});
s.on('join-error', (e) => { say('error', { error: e?.error }); });
s.on('professor-speak', (m) => {
  const mm = /_seg_(\d+)$/.exec(m?.id || '');
  if (m?.type === 'lecture' && mm) {
    lastSegIndex = Number(mm[1]);
    lastSegAt = Date.now();
  }
});
s.on('floor-state', (d) => {
  if (d?.activeSpeaker?.userId === PID && !granted) {
    granted = true;
    say('granted');
  }
});
s.on('lecture-control', (d) => {
  if (d?.action === 'pause-for-floor' && d?.activeSpeaker?.userId === PID) {
    // Report MY checkpoint — wall-clock offset inside the current segment,
    // sentenceIndex in the holder's own language (same math as the client).
    const offMs = lastSegAt != null ? Math.max(0, Date.now() - lastSegAt) : 0;
    const offSec = offMs / 1000;
    s.emit('lecture-checkpoint', {
      lectureId: LECTURE,
      language: LANG,
      segmentIndex: lastSegIndex,
      playbackOffsetMs: Math.round(offMs),
      sentenceIndex: sentIdx(lastSegIndex, offSec),
    });
    say('checkpoint', { segmentIndex: lastSegIndex, offSec: +offSec.toFixed(2) });
  }
  if (d?.action === 'resume' && awaitingResume) {
    awaitingResume = false;
    say('resume');
  }
});
s.on('floor-ready', () => {
  say('ready');
  setTimeout(() => {
    s.emit('ask-floor-question', { question: 'eval question', lectureId: LECTURE });
    say('asked');
  }, askDelayMs);
});
s.on('floor-question-error', (d) => say('question-error', { error: d?.error }));

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const cmd = line.trim();
  if (cmd === 'start') s.emit('lecture.start', { lectureId: LECTURE });
  if (cmd === 'end') {
    // Reset a stalled run before restarting: a reload-killed client never
    // reports lecture-segment-ended, so the server-side run can sit on a
    // half-finished unit forever and reject 'start' as a duplicate.
    s.emit('lecture-ended');
    say('ended');
  }
  if (cmd === 'hold' || cmd.startsWith('hold ')) {
    askDelayMs = Number(cmd.split(' ')[1]) || 0;
    awaitingResume = true;
    granted = false;
    s.emit('request-floor');
  }
  if (cmd === 'pos') {
    // Room frontier: last professor-speak segment head + wall-clock elapsed.
    // The reconnect-after-resume oracle measures against this.
    say('pos', {
      segmentIndex: lastSegIndex,
      offSec: lastSegAt != null
        ? +((Date.now() - lastSegAt) / 1000).toFixed(2) : null,
    });
  }
  if (cmd === 'quit') process.exit(0);
});
