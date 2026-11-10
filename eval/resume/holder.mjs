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
let lastSegIndex = null;
let lastSegAt = null; // wall ms when the current segment's speak broadcast arrived

const s = io(BASE, { transports: ['websocket'], reconnection: false });
s.on('connect', () => {
  s.emit('join', { roomId: ROOM, name: PID, participantId: PID });
});
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
  s.emit('ask-floor-question', { question: 'eval question', lectureId: LECTURE });
  say('asked');
});
s.on('floor-question-error', (d) => say('question-error', { error: d?.error }));

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const cmd = line.trim();
  if (cmd === 'start') s.emit('lecture.start', { lectureId: LECTURE });
  if (cmd === 'hold') {
    awaitingResume = true;
    s.emit('request-floor');
  }
  if (cmd === 'quit') process.exit(0);
});
