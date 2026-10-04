// NCIP state-machine tests — run with: node --test modules/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NcipRoom, ProfessorStatus as S } from './ncipRoom.mjs';

const events = (effects) => (effects || []).map((e) => e.event);
const lectureCtl = (effects) =>
  (effects || []).filter((e) => e.event === 'lecture-control').map((e) => e.data.action);

const CP = { lectureId: 'Lecture_1', segmentIndex: 2, playbackOffsetMs: 4500, language: 'en' };

// Drive a room to LECTURING through the real protocol: grant -> holder
// checkpoint -> release -> resume.
function lecturingRoom() {
  const room = new NcipRoom('test');
  room.requestFloor('setup');
  room.submitCheckpoint('setup', { ...CP, playbackOffsetMs: 1000 });
  room.releaseFloor('setup');
  assert.equal(room.professor.status, S.LECTURING);
  assert.equal(room.interruption.checkpoint, null);
  return room;
}

// Drive a room to PAUSED with a valid holder checkpoint.
function pausedRoom(holder = 'alice') {
  const room = lecturingRoom();
  room.requestFloor(holder);
  room.submitCheckpoint(holder, CP);
  assert.equal(room.professor.status, S.PAUSED);
  assert.ok(room.interruption.checkpoint);
  return room;
}

// Drive a room to ANSWERING.
function answeringRoom(durationMs = 5000) {
  const room = pausedRoom();
  room.submitQuestion('alice', 'q');
  const fx = room.answerReady('ans-1', { text: 'a' }, durationMs);
  assert.equal(room.professor.status, S.ANSWERING);
  return { room, fx };
}

test('1. raise hand -> grant -> pause -> checkpoint -> question -> answer -> exact resume', () => {
  const room = lecturingRoom();

  let fx = room.requestFloor('alice');
  assert.equal(room.floor.holder, 'alice');
  assert.equal(room.professor.status, S.PAUSED);
  assert.deepEqual(lectureCtl(fx), ['pause-for-floor']);

  // holder reports checkpoint -> floor-ready ack addressed to the holder
  fx = room.submitCheckpoint('alice', CP);
  assert.equal(room.interruption.checkpoint.playbackOffsetMs, 4500);
  const ready = fx.find((e) => e.event === 'floor-ready');
  assert.equal(ready.to, 'alice');

  const q = room.submitQuestion('alice', 'what is dct?');
  assert.equal(q.ok, true);
  assert.equal(room.professor.status, S.THINKING);
  assert.deepEqual(lectureCtl(q.effects), ['thinking']);

  fx = room.answerReady('ans-1', { text: 'DCT is...', audioUrl: '/x.wav' }, 3000);
  assert.equal(room.professor.status, S.ANSWERING);
  const speak = fx.find((e) => e.event === 'professor-speak');
  assert.equal(speak.data.floorAnswer, true);
  assert.equal(speak.data.durationMs, 3000);

  // server-side timer expiry -> resume carries the holder's checkpoint
  fx = room.answerTimeExpired('ans-1');
  assert.deepEqual(lectureCtl(fx), ['resume']);
  const resume = fx.find((e) => e.event === 'lecture-control');
  assert.equal(resume.data.checkpoint.segmentIndex, 2);
  assert.equal(resume.data.checkpoint.playbackOffsetMs, 4500);
  assert.equal(room.professor.status, S.LECTURING);
  assert.equal(room.floor.holder, null);
  assert.equal(room.interruption.checkpoint, null);
});

test('2. two students raise hand -> first holds, second queued FIFO', () => {
  const room = lecturingRoom();
  room.requestFloor('alice');
  const fx = room.requestFloor('bob');
  assert.equal(room.floor.holder, 'alice');
  assert.deepEqual(room.floor.queue, ['bob']);
  assert.ok(events(fx).includes('floor-state'));
  assert.deepEqual(lectureCtl(fx), []);
});

test('3a. non-holder question is rejected, state untouched', () => {
  const room = pausedRoom();
  const r = room.submitQuestion('bob', 'not my floor');
  assert.equal(r.ok, false);
  assert.equal(room.professor.status, S.PAUSED);
  assert.equal(room.floor.holder, 'alice');
});

test('3b. question before checkpoint must not enter THINKING', () => {
  const room = lecturingRoom();
  room.requestFloor('alice'); // granted, PAUSED, but no checkpoint yet
  const r = room.submitQuestion('alice', 'too early');
  assert.equal(r.ok, false);
  assert.match(r.error, /checkpoint/i);
  assert.equal(room.professor.status, S.PAUSED);
});

test('3c. after checkpoint rejection, valid question succeeds', () => {
  const room = lecturingRoom();
  room.requestFloor('alice');
  assert.equal(room.submitQuestion('alice', 'early').ok, false);
  room.submitCheckpoint('alice', CP);
  assert.equal(room.submitQuestion('alice', 'on time').ok, true);
  assert.equal(room.professor.status, S.THINKING);
});

test('4. duplicate raise-hand does not duplicate queue/holder', () => {
  const room = lecturingRoom();
  room.requestFloor('alice');
  assert.deepEqual(room.requestFloor('alice'), []);
  room.requestFloor('bob');
  assert.deepEqual(room.requestFloor('bob'), []);
  assert.deepEqual(room.floor.queue, ['bob']);
});

test('5. grant emits pause-for-floor exactly once per grant', () => {
  const room = lecturingRoom();
  const fx = room.requestFloor('alice');
  const pauses = fx.filter(
    (e) => e.event === 'lecture-control' && e.data.action === 'pause-for-floor'
  );
  assert.equal(pauses.length, 1);
  assert.equal(pauses[0].data.activeSpeaker.userId, 'alice');
});

test('6a. non-holder checkpoint cannot write the canonical checkpoint', () => {
  const room = lecturingRoom();
  room.requestFloor('alice');
  room.requestFloor('bob');
  assert.deepEqual(room.submitCheckpoint('bob', { ...CP, playbackOffsetMs: 9999 }), []);
  assert.equal(room.interruption.checkpoint, null);
});

test('6b. later checkpoint reports cannot replace the holder checkpoint', () => {
  const room = lecturingRoom();
  room.requestFloor('alice');
  room.submitCheckpoint('alice', CP);
  // holder re-report is ignored (first write wins)
  assert.deepEqual(room.submitCheckpoint('alice', { ...CP, playbackOffsetMs: 1 }), []);
  // non-holder report is ignored
  room.requestFloor('bob');
  assert.deepEqual(room.submitCheckpoint('bob', { ...CP, playbackOffsetMs: 2 }), []);
  assert.equal(room.interruption.checkpoint.playbackOffsetMs, 4500);
  assert.equal(room.interruption.checkpoint.reportedBy, 'alice');
});

test('6c. checkpoint resets for the next holder', () => {
  const room = pausedRoom();
  room.requestFloor('bob');
  room.releaseFloor('alice'); // bob granted -> checkpoint cleared
  assert.equal(room.floor.holder, 'bob');
  assert.equal(room.interruption.checkpoint, null);
  // bob cannot ask until HIS checkpoint arrives
  assert.equal(room.submitQuestion('bob', 'q').ok, false);
  const fx = room.submitCheckpoint('bob', { ...CP, playbackOffsetMs: 777 });
  assert.equal(room.interruption.checkpoint.playbackOffsetMs, 777);
  assert.equal(fx.find((e) => e.event === 'floor-ready').to, 'bob');
  assert.equal(room.submitQuestion('bob', 'q').ok, true);
});

test('7. queued student gets floor after answer ends — no resume in between', () => {
  const room = pausedRoom();
  room.requestFloor('bob');
  room.submitQuestion('alice', 'q1');
  room.answerReady('ans-1', { text: 'a' }, 3000);
  const fx = room.answerTimeExpired('ans-1');
  assert.equal(room.floor.holder, 'bob');
  assert.equal(room.professor.status, S.PAUSED);
  assert.deepEqual(lectureCtl(fx), ['pause-for-floor']);
  assert.ok(!lectureCtl(fx).includes('resume'));
});

test('8. release-floor before asking -> next holder or resume', () => {
  const room = lecturingRoom();
  room.requestFloor('alice');
  room.requestFloor('bob');
  let fx = room.releaseFloor('alice');
  assert.equal(room.floor.holder, 'bob');
  assert.equal(room.professor.status, S.PAUSED);
  fx = room.releaseFloor('bob');
  assert.equal(room.floor.holder, null);
  assert.deepEqual(lectureCtl(fx), ['resume']);
  assert.equal(room.professor.status, S.LECTURING);
});

test('9a. holder disconnects before asking -> next queued gets floor', () => {
  const room = lecturingRoom();
  room.requestFloor('alice');
  room.requestFloor('bob');
  const fx = room.disconnect('alice');
  assert.equal(room.floor.holder, 'bob');
  assert.equal(room.professor.status, S.PAUSED);
  assert.deepEqual(lectureCtl(fx), ['pause-for-floor']);
});

test('9b. holder disconnects before asking, none queued -> lecture resumes', () => {
  const room = pausedRoom();
  const fx = room.disconnect('alice');
  assert.equal(room.floor.holder, null);
  assert.deepEqual(lectureCtl(fx), ['resume']);
  assert.equal(room.professor.status, S.LECTURING);
});

test('9c. holder disconnects during ANSWERING -> answer finishes for the room', () => {
  const { room } = answeringRoom(3000);
  let fx = room.disconnect('alice');
  assert.equal(room.professor.status, S.ANSWERING);
  assert.ok(!lectureCtl(fx).includes('resume'));
  fx = room.answerTimeExpired('ans-1');
  assert.deepEqual(lectureCtl(fx), ['resume']);
  assert.equal(room.professor.status, S.LECTURING);
});

test('10a. LLM/TTS failure leaves THINKING, releases holder, resumes', () => {
  const room = pausedRoom();
  room.submitQuestion('alice', 'q');
  const fx = room.answerFailed('alice', 'fail');
  assert.equal(room.floor.holder, null);
  assert.ok(events(fx).includes('floor-question-error'));
  assert.ok(lectureCtl(fx).includes('answer-error'));
  assert.ok(lectureCtl(fx).includes('resume'));
  assert.equal(room.professor.status, S.LECTURING);
});

test('10b. LLM/TTS failure with queue -> next student gets floor, no resume', () => {
  const room = pausedRoom();
  room.requestFloor('bob');
  room.submitQuestion('alice', 'q');
  const fx = room.answerFailed('alice', 'fail');
  assert.equal(room.floor.holder, 'bob');
  assert.equal(room.professor.status, S.PAUSED);
  assert.ok(lectureCtl(fx).includes('pause-for-floor'));
  assert.ok(!lectureCtl(fx).includes('resume'));
});

test('11a. early client answer-ended cannot end the answer for the room', () => {
  const { room } = answeringRoom(5000); // answer is 5s long
  const startedAt = room.currentAnswer.startedAt;
  // A fast client reports at t+1s — must be ignored.
  assert.deepEqual(room.answerEnded('ans-1', startedAt + 1000), []);
  assert.equal(room.professor.status, S.ANSWERING);
  // After the measured duration elapsed the same report is accepted as
  // fallback (e.g. if the server timer were delayed).
  const fx = room.answerEnded('ans-1', startedAt + 5000);
  assert.deepEqual(lectureCtl(fx), ['resume']);
  assert.equal(room.professor.status, S.LECTURING);
});

test('11b. server timer alone completes the answer — room never stuck', () => {
  const { room } = answeringRoom(5000);
  // No client reports at all: the server-side timeout advances the room.
  const fx = room.answerTimeExpired('ans-1');
  assert.deepEqual(lectureCtl(fx), ['resume']);
  assert.equal(room.professor.status, S.LECTURING);
});

test('11c. duplicate/stale completion cannot cause multiple resumes', () => {
  const { room } = answeringRoom(1000);
  assert.deepEqual(room.answerTimeExpired('wrong-id'), []);
  room.answerTimeExpired('ans-1');
  // All later completion signals are ignored.
  assert.deepEqual(room.answerTimeExpired('ans-1'), []);
  assert.deepEqual(room.answerEnded('ans-1', Date.now() + 99999), []);
  assert.equal(room.professor.status, S.LECTURING);
});

test('11d. unknown-duration answers still complete via client report', () => {
  const room = pausedRoom();
  room.submitQuestion('alice', 'q');
  room.answerReady('ans-1', { text: 'a' }, null); // durationMs unknown
  const fx = room.answerEnded('ans-1', Date.now());
  assert.deepEqual(lectureCtl(fx), ['resume']);
});

test('12. second question while THINKING/ANSWERING is rejected', () => {
  const room = pausedRoom();
  room.submitQuestion('alice', 'q1');
  assert.equal(room.submitQuestion('alice', 'q2').ok, false); // THINKING
  room.answerReady('ans-1', { text: 'a' }, 1000);
  assert.equal(room.submitQuestion('alice', 'q2').ok, false); // ANSWERING
});

test('13. cancel-floor-request removes only the queued student', () => {
  const room = lecturingRoom();
  room.requestFloor('alice');
  room.requestFloor('bob');
  room.requestFloor('carol');
  room.cancelRequest('bob');
  assert.deepEqual(room.floor.queue, ['carol']);
  assert.equal(room.floor.holder, 'alice');
});

test('15. resume carries the canonical checkpoint of the CURRENT holder', () => {
  const room = lecturingRoom();
  room.requestFloor('alice');
  room.requestFloor('bob');
  room.submitCheckpoint('alice', CP);                       // alice @ 4500ms
  room.releaseFloor('alice');                                // bob granted, cp cleared
  room.submitCheckpoint('bob', { ...CP, segmentIndex: 7, playbackOffsetMs: 12000 });
  room.submitQuestion('bob', 'q');
  room.answerReady('ans-1', { text: 'a' }, 1000);
  const fx = room.answerTimeExpired('ans-1');
  const resume = fx.find((e) => e.event === 'lecture-control' && e.data.action === 'resume');
  // Canonical resume target is bob's checkpoint, not alice's.
  assert.equal(resume.data.checkpoint.segmentIndex, 7);
  assert.equal(resume.data.checkpoint.playbackOffsetMs, 12000);
  assert.equal(resume.data.checkpoint.reportedBy, 'bob');
});

test('14. holder with no local lecture can still complete the protocol', () => {
  const room = lecturingRoom();
  room.requestFloor('alice');
  // Holder isn't playing the lecture locally: reports a null checkpoint.
  const fx = room.submitCheckpoint('alice', {
    lectureId: null, segmentIndex: null, playbackOffsetMs: 0, language: 'en',
  });
  assert.ok(room.interruption.checkpoint);
  assert.ok(fx.some((e) => e.event === 'floor-ready' && e.to === 'alice'));
  assert.equal(room.submitQuestion('alice', 'q').ok, true);
});
