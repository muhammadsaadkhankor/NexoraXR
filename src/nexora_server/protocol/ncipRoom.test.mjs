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

// ---------------------------------------------------------------------------
// NCIP Slice 2 — authoritative stateVersion + recovery snapshot
// ---------------------------------------------------------------------------

test('16a. stateVersion starts at 0 and bumps only on authoritative changes', () => {
  const room = new NcipRoom('test');
  assert.equal(room.stateVersion, 0);

  // No-ops must not bump.
  room.requestFloor('ghost'); // wait — this DOES grant; use real no-ops below.
});

test('16b. every authoritative transition increments stateVersion', () => {
  const room = new NcipRoom('v');
  assert.equal(room.stateVersion, 0);

  room.requestFloor('alice');            // holder grant -> PAUSED
  assert.equal(room.stateVersion, 1);
  room.requestFloor('bob');              // queue push
  assert.equal(room.stateVersion, 2);
  room.submitCheckpoint('alice', CP);    // canonical checkpoint write
  assert.equal(room.stateVersion, 3);
  room.cancelRequest('bob');             // queue splice
  assert.equal(room.stateVersion, 4);
  room.requestFloor('bob');
  room.submitQuestion('alice', 'q');     // THINKING
  assert.equal(room.stateVersion, 6);
  room.answerReady('a1', { text: 'x' }, 1000); // ANSWERING + currentAnswer
  assert.equal(room.stateVersion, 7);
  room.answerTimeExpired('a1');          // finish -> advance -> bob granted
  assert.equal(room.stateVersion, 8);
  room.disconnect('bob');                // holder disconnect -> advance
  assert.equal(room.stateVersion, 9);
});

test('16c. rejected/no-op transitions never bump the version', () => {
  const room = pausedRoom();
  const v = room.stateVersion;
  room.requestFloor('alice');            // already holder -> []
  room.requestFloor('carol');
  room.requestFloor('carol');            // already queued -> []
  room.submitCheckpoint('carol', CP);    // non-holder -> []
  room.submitCheckpoint('alice', CP);    // duplicate write -> []
  room.releaseFloor('carol');            // non-holder -> []
  room.cancelRequest('nobody');          // not queued -> []
  room.answerReady('late', {}, 1);       // not THINKING -> []
  room.answerTimeExpired('nope');        // not ANSWERING -> []
  room.answerEnded('nope');              // not ANSWERING -> []
  room.submitQuestion('carol', 'x');     // non-holder -> rejected
  room.submitQuestion('alice', 'x');     // valid — this one bumps
  assert.equal(room.stateVersion, v + 2); // +1 carol queue, +1 submitQuestion
});

test('17a. snapshot captures floor, status, checkpoint and version while PAUSED', () => {
  const room = pausedRoom();
  room.requestFloor('bob');
  const snap = room.snapshot();
  assert.equal(snap.stateVersion, room.stateVersion);
  assert.equal(snap.floor.holder, 'alice');
  assert.deepEqual(snap.floor.queue, ['bob']);
  assert.equal(snap.professor.status, 'PAUSED');
  assert.equal(snap.lecture.active, true);
  assert.equal(snap.lecture.lectureId, 'Lecture_1');
  assert.equal(snap.lecture.segmentIndex, 2);
  assert.equal(snap.lecture.playbackOffsetMs, 4500);
  assert.equal(snap.lecture.language, 'en');
  assert.equal(snap.interruption.checkpoint.reportedBy, 'alice');
  assert.equal(snap.currentAnswer, null);
});

test('17b. snapshot during ANSWERING carries the live answer', () => {
  const { room } = answeringRoom(5000);
  const snap = room.snapshot();
  assert.equal(snap.professor.status, 'ANSWERING');
  assert.equal(snap.currentAnswer.id, 'ans-1');
  assert.equal(snap.currentAnswer.startedAt, room.currentAnswer.startedAt);
  assert.equal(snap.currentAnswer.durationMs, 5000);
  assert.equal(snap.floor.holder, 'alice');
});

test('17e. currentAnswer carries the replay payload for late joiners', () => {
  const room = pausedRoom();
  room.submitQuestion('alice', 'q');
  room.answerReady('a9', {
    text: 'the answer text', audioUrl: '/api/lecture/answer_audio/x',
    lipsync: { mouthCues: [] }, animation: 'TalkingOne', facialExpression: 'smile',
  }, 20000);
  const snap = room.snapshot();
  assert.equal(snap.currentAnswer.audioUrl, '/api/lecture/answer_audio/x');
  assert.equal(snap.currentAnswer.text, 'the answer text');
  assert.deepEqual(snap.currentAnswer.lipsync, { mouthCues: [] });
  assert.equal(snap.currentAnswer.animation, 'TalkingOne');
  assert.equal(snap.currentAnswer.facialExpression, 'smile');
  // serverNow lets the client compute elapsed on the same clock as startedAt.
  assert.ok(Number.isFinite(snap.serverNow) && snap.serverNow >= snap.currentAnswer.startedAt);
});

test('17c. snapshot during LECTURING exposes the canonical lecture position', () => {
  const room = lecturingRoom();
  const snap = room.snapshot();
  assert.equal(snap.professor.status, 'LECTURING');
  assert.equal(snap.lecture.active, true);
  // Checkpoint cleared after resume — position fields reset to safe nulls.
  assert.equal(snap.lecture.segmentIndex, null);
  assert.equal(snap.currentAnswer, null);
});

test('17d. snapshot on a fresh room is a valid empty baseline', () => {
  const snap = new NcipRoom('r').snapshot();
  assert.equal(snap.stateVersion, 0);
  assert.equal(snap.floor.holder, null);
  assert.deepEqual(snap.floor.queue, []);
  assert.equal(snap.professor.status, 'IDLE');
  assert.equal(snap.lecture.active, false);
  assert.equal(snap.currentAnswer, null);
});

test('18. reconnect-style resync returns latest state, not stale state', () => {
  const room = pausedRoom();
  const before = room.snapshot();
  // "Client" syncs at v_before, then more transitions happen server-side.
  room.submitQuestion('alice', 'q');
  room.answerReady('a1', { text: 'x' }, 100);
  const after = room.snapshot();
  assert.ok(after.stateVersion > before.stateVersion);
  assert.equal(after.professor.status, 'ANSWERING');
  assert.equal(after.currentAnswer.id, 'a1');
});

// ---------------------------------------------------------------------------
// NCIP Slice 3 — authoritative room-language coordination
// ---------------------------------------------------------------------------

test('19a. valid language.change bumps version and broadcasts', () => {
  const room = lecturingRoom();
  const v = room.stateVersion;
  const r = room.changeLanguage('anyone', 'ar');
  assert.equal(r.ok, true);
  assert.equal(room.language.roomLanguage, 'ar');
  assert.equal(room.stateVersion, v + 1);
  const lc = r.effects.find((e) => e.event === 'lecture-control');
  assert.equal(lc.data.action, 'language-change');
  assert.equal(lc.data.language, 'ar');
  assert.ok(r.effects.some((e) => e.event === 'floor-state'));
});

test('19b. unsupported language rejected, no state change', () => {
  const room = pausedRoom();
  const v = room.stateVersion;
  const r = room.changeLanguage('alice', 'jp');
  assert.equal(r.ok, false);
  assert.match(r.error, /unsupported/i);
  assert.equal(room.language.roomLanguage, 'en');
  assert.equal(room.stateVersion, v);
});

test('19c. same-language request is a no-op, version untouched', () => {
  const room = lecturingRoom();
  room.changeLanguage('x', 'fr');
  const v = room.stateVersion;
  const r = room.changeLanguage('x', 'fr');
  assert.equal(r.ok, true);
  assert.deepEqual(r.effects, []);
  assert.equal(room.stateVersion, v);
});

test('19d. LECTURING: change emits language-change, floor/checkpoint untouched', () => {
  const room = lecturingRoom();
  const r = room.changeLanguage('x', 'de');
  assert.equal(room.professor.status, S.LECTURING);
  assert.equal(room.lectureActive, true);
  assert.equal(room.interruption.checkpoint, null);
  assert.deepEqual(lectureCtl(r.effects), ['language-change']);
});

test('19e. PAUSED: checkpoint language retargeted, floor preserved, no resume', () => {
  const room = pausedRoom();
  room.requestFloor('bob');
  const r = room.changeLanguage('anyone', 'ar');
  assert.equal(room.professor.status, S.PAUSED);
  assert.equal(room.floor.holder, 'alice');
  assert.deepEqual(room.floor.queue, ['bob']);
  assert.equal(room.interruption.checkpoint.language, 'ar');
  assert.equal(room.interruption.checkpoint.segmentIndex, 2); // position kept
  assert.ok(!lectureCtl(r.effects).includes('resume'));
});

test('19f. THINKING: question state preserved, checkpoint language updated', () => {
  const room = pausedRoom();
  room.submitQuestion('alice', 'q');
  room.changeLanguage('x', 'fr');
  assert.equal(room.professor.status, S.THINKING);
  assert.equal(room.interruption.checkpoint.language, 'fr');
  // Answer still generated and completes normally.
  room.answerReady('a1', { text: 'r' }, 100);
  const fx = room.answerTimeExpired('a1');
  const resume = fx.find((e) => e.event === 'lecture-control' && e.data.action === 'resume');
  assert.equal(resume.data.checkpoint.language, 'fr'); // resume in new language
});

test('19g. ANSWERING: answer completes, then resume carries new language', () => {
  const { room } = answeringRoom(5000);
  const r = room.changeLanguage('x', 'es');
  // Answer not interrupted.
  assert.equal(room.professor.status, S.ANSWERING);
  assert.equal(room.currentAnswer.id, 'ans-1');
  const fx = room.answerTimeExpired('ans-1');
  const resume = fx.find((e) => e.event === 'lecture-control' && e.data.action === 'resume');
  assert.equal(resume.data.checkpoint.language, 'es');
  assert.equal(resume.data.checkpoint.segmentIndex, 2);
});

test('19h. resume emitted after a language change carries the new language', () => {
  const room = pausedRoom();
  room.changeLanguage('x', 'de');
  const fx = room.releaseFloor('alice');
  const resume = fx.find((e) => e.event === 'lecture-control' && e.data.action === 'resume');
  assert.equal(resume.data.checkpoint.language, 'de');
});

test('19i. snapshot carries authoritative room language', () => {
  const room = lecturingRoom();
  assert.equal(room.snapshot().language.roomLanguage, 'en');
  room.changeLanguage('x', 'ar');
  assert.equal(room.snapshot().language.roomLanguage, 'ar');
});

test('19j. late-join snapshot during PAUSED reports new-language checkpoint', () => {
  const room = pausedRoom();
  room.changeLanguage('x', 'fr');
  const snap = room.snapshot();
  assert.equal(snap.language.roomLanguage, 'fr');
  assert.equal(snap.interruption.checkpoint.language, 'fr');
  assert.equal(snap.lecture.language, 'fr');
  assert.equal(snap.lecture.segmentIndex, 2);
});

// ---------------------------------------------------------------------------
// NCIP Slice 4 — session & participant lifecycle
// ---------------------------------------------------------------------------

test('20a. join creates one authoritative participant', () => {
  const room = new NcipRoom('s4');
  const r = room.joinParticipant('alice', 'sock1', 1000);
  assert.equal(r.isNew, true);
  const p = room.session.participants.get('alice');
  assert.deepEqual({ connected: p.connected, socketId: p.socketId, joinedAt: p.joinedAt, disconnectedAt: p.disconnectedAt },
    { connected: true, socketId: 'sock1', joinedAt: 1000, disconnectedAt: null });
  assert.equal(room.stateVersion, 1);
});

test('20b. duplicate join does not duplicate or bump', () => {
  const room = new NcipRoom('s4');
  room.joinParticipant('alice', 'sock1');
  const v = room.stateVersion;
  const r = room.joinParticipant('alice', 'sock1');
  assert.equal(r.isNew, false);
  assert.equal(r.reconnected, false);
  assert.equal(room.participantCount(), 1);
  assert.equal(room.stateVersion, v);
});

test('20c. disconnect marks offline, preserves protocol position', () => {
  const room = lecturingRoom();
  room.joinParticipant('alice', 's1');
  room.requestFloor('alice');
  const ok = room.participantDisconnected('alice', 5000);
  assert.equal(ok, true);
  const p = room.session.participants.get('alice');
  assert.equal(p.connected, false);
  assert.equal(p.disconnectedAt, 5000);
  assert.equal(room._graceDeadlines.get('alice'), 5000 + room.RECONNECT_GRACE_MS);
  assert.equal(room.floor.holder, 'alice'); // floor kept during grace
  assert.equal(room.professor.status, S.PAUSED);
});

test('20d. reconnect within grace preserves queue position', () => {
  const room = pausedRoom();
  room.joinParticipant('bob', 'sockB1');
  room.requestFloor('bob'); // queued behind alice
  room.participantDisconnected('bob');
  const r = room.joinParticipant('bob', 'sockB2'); // rebind new socket
  assert.equal(r.reconnected, true);
  assert.equal(r.isNew, false);
  assert.deepEqual(room.floor.queue, ['bob']);
  assert.equal(room.session.participants.get('bob').socketId, 'sockB2');
  assert.equal(room._graceDeadlines.has('bob'), false);
});

test('20e. reconnect within grace preserves floor ownership', () => {
  const room = pausedRoom(); // alice holds
  room.joinParticipant('alice', 'sA1');
  room.participantDisconnected('alice');
  room.joinParticipant('alice', 'sA2');
  assert.equal(room.floor.holder, 'alice');
  assert.equal(room.session.participants.get('alice').socketId, 'sA2');
});

test('20f. queued participant is removed at grace expiry', () => {
  const room = pausedRoom(); // alice holder
  room.joinParticipant('bob', 'sb');
  room.requestFloor('bob');
  room.participantDisconnected('bob');
  const fx = room.expireGrace('bob');
  assert.deepEqual(room.floor.queue, []);
  assert.equal(room.floor.holder, 'alice'); // untouched
  assert.ok(events(fx).includes('floor-state'));
  assert.equal(room.session.participants.has('bob'), false);
});

test('20g. holder expiry before asking grants next queued student', () => {
  const room = lecturingRoom();
  room.joinParticipant('alice', 'sa');
  room.joinParticipant('bob', 'sb');
  room.requestFloor('alice');
  room.requestFloor('bob');
  room.participantDisconnected('alice');
  const fx = room.expireGrace('alice');
  assert.equal(room.floor.holder, 'bob');
  assert.equal(room.professor.status, S.PAUSED);
  assert.deepEqual(lectureCtl(fx), ['pause-for-floor']);
});

test('20h. holder expiry with empty queue resumes lecture from checkpoint', () => {
  const room = pausedRoom(); // alice holder, checkpoint exists
  room.joinParticipant('alice', 'sa');
  room.participantDisconnected('alice');
  const fx = room.expireGrace('alice');
  assert.equal(room.floor.holder, null);
  assert.equal(room.professor.status, S.LECTURING);
  const resume = fx.find((e) => e.event === 'lecture-control' && e.data.action === 'resume');
  assert.equal(resume.data.checkpoint.segmentIndex, 2);
});

test('20i. holder disconnect during ANSWERING: answer finishes for the room', () => {
  const { room } = answeringRoom(3000);
  room.joinParticipant('alice', 'sa');
  room.participantDisconnected('alice');
  // Grace expiry still removes the holder's floor (Slice 1 rule) but the
  // answer keeps playing; resume happens on answer completion.
  const fx = room.expireGrace('alice');
  assert.equal(room.professor.status, S.ANSWERING);
  assert.ok(!lectureCtl(fx).includes('resume'));
  const done = room.answerTimeExpired('ans-1');
  assert.deepEqual(lectureCtl(done), ['resume']);
  assert.equal(room.professor.status, S.LECTURING);
});

test('20j. explicit leave removes immediately', () => {
  const room = lecturingRoom();
  room.joinParticipant('alice', 'sa');
  room.requestFloor('alice');
  const fx = room.leave('alice');
  assert.equal(room.session.participants.has('alice'), false);
  assert.equal(room.floor.holder, null);
  assert.deepEqual(lectureCtl(fx), ['resume']);
});

test('20k. stale grace timer cannot affect a reconnected participant', () => {
  const room = lecturingRoom();
  room.joinParticipant('alice', 's1');
  room.requestFloor('alice');
  room.participantDisconnected('alice');
  room.joinParticipant('alice', 's2'); // reconnected before expiry
  const fx = room.expireGrace('alice');  // stale timer fires late
  assert.deepEqual(fx, []);
  assert.equal(room.floor.holder, 'alice');
  assert.equal(room.session.participants.get('alice').connected, true);
});

test('20l. snapshot exposes participants without socket internals', () => {
  const room = new NcipRoom('s4');
  room.joinParticipant('alice', 'sockXYZ', 1234);
  room.participantDisconnected('alice', 2000);
  const snap = room.snapshot();
  const p = snap.session.participants.alice;
  assert.equal(p.connected, false);
  assert.equal(p.joinedAt, 1234);
  assert.equal(p.disconnectedAt, 2000);
  assert.equal('socketId' in p, false); // internal routing not exposed
});

test('20m. session lifecycle events participate in versioning', () => {
  const room = new NcipRoom('s4');
  room.joinParticipant('alice', 's1');        // v1
  room.participantDisconnected('alice');      // v2
  room.joinParticipant('alice', 's2');        // v3 (reconnect flips connected)
  room.expireGrace('alice');                  // stale timer — no bump
  assert.equal(room.stateVersion, 3);
  assert.equal(room.snapshot().stateVersion, 3);
});

// ---------------------------------------------------------------------------
// NCIP Slice 5 — hardening: invariants, floor timeout, timers, convergence
// ---------------------------------------------------------------------------

const check = (room) => room.assertConsistent();

// Drive a full floor Q&A cycle while asserting invariants after every step.
test('21a. invariants hold across a full Q&A cycle', () => {
  const room = lecturingRoom(); check(room);
  room.requestFloor('alice'); check(room);
  room.requestFloor('bob'); check(room);
  room.submitCheckpoint('alice', CP); check(room);
  room.submitQuestion('alice', 'q'); check(room);
  room.answerReady('a1', { text: 'x' }, 100); check(room);
  room.answerTimeExpired('a1'); check(room); // bob granted
  assert.equal(room.floor.holder, 'bob'); check(room);
  room.leave('bob'); check(room);            // resume -> LECTURING
});

test('21b. floor timeout after deadline revokes holder, grants next', () => {
  const room = lecturingRoom();
  room.requestFloor('alice');
  room.requestFloor('bob');
  room.submitCheckpoint('alice', CP);
  const d = room.floorDeadline;
  assert.equal(d.holder, 'alice');
  assert.equal(room.FLOOR_TIMEOUT_MS, 30000);
  const fx = room.floorTimeoutExpired('alice', d.expiresAt + 1);
  assert.equal(room.floor.holder, 'bob');
  assert.equal(room.professor.status, S.PAUSED);
  assert.deepEqual(lectureCtl(fx), ['pause-for-floor']);
  check(room);
});

test('21c. floor timeout with empty queue resumes from canonical checkpoint', () => {
  const room = pausedRoom(); // alice holder, cp seg 2 @4500
  const fx = room.floorTimeoutExpired('alice', room.floorDeadline.expiresAt + 1);
  const resume = fx.find((e) => e.event === 'lecture-control' && e.data.action === 'resume');
  assert.equal(resume.data.checkpoint.segmentIndex, 2);   // never seg 0 (S6)
  assert.equal(resume.data.checkpoint.playbackOffsetMs, 4500);
  assert.equal(room.professor.status, S.LECTURING);
  check(room);
});

test('21d. question submission disarms the floor timeout', () => {
  const room = pausedRoom();
  room.submitQuestion('alice', 'q');
  assert.equal(room.floorDeadline, null);
  const fx = room.floorTimeoutExpired('alice', Date.now() + 99999);
  assert.deepEqual(fx, []); // stale firing is a no-op
  assert.equal(room.professor.status, S.THINKING);
  check(room);
});

test('21e. stale floor timeout cannot revoke the NEXT holder', () => {
  const room = lecturingRoom();
  room.requestFloor('alice');
  room.requestFloor('bob');
  room.submitCheckpoint('alice', CP);
  room.disconnect('alice');                 // bob granted via advance
  room.submitCheckpoint('bob', CP);         // bob arms his own deadline
  // Alice's old timer fires late — wrong holder, must be a no-op.
  assert.deepEqual(room.floorTimeoutExpired('alice', Date.now() + 99999), []);
  assert.equal(room.floor.holder, 'bob');
  // Bob's own deadline still armed and un-expired.
  assert.deepEqual(room.floorTimeoutExpired('bob', Date.now()), []);
  check(room);
});

test('21f. premature floor-timeout call is a no-op', () => {
  const room = pausedRoom();
  assert.deepEqual(room.floorTimeoutExpired('alice', room.floorDeadline.expiresAt - 1), []);
  assert.equal(room.floor.holder, 'alice');
});

test('21g. grace disconnect + reconnect does not disturb an armed timeout', () => {
  const room = pausedRoom();
  room.joinParticipant('alice', 's1');
  room.participantDisconnected('alice');
  room.joinParticipant('alice', 's2'); // reconnect within grace
  assert.equal(room.floor.holder, 'alice');
  assert.ok(room.floorDeadline);       // timeout still armed for same holder
  const fx = room.floorTimeoutExpired('alice', room.floorDeadline.expiresAt + 1);
  assert.equal(room.floor.holder, null);
  assert.deepEqual(lectureCtl(fx), ['resume']);
  check(room);
});

test('21h. duplicate answer-expiry cannot resume twice', () => {
  const { room } = answeringRoom(1000);
  room.answerTimeExpired('ans-1');
  const again = room.answerTimeExpired('ans-1');
  assert.deepEqual(again, []);
  assert.equal(room.professor.status, S.LECTURING);
  check(room);
});

test('21i. LLM/TTS failure mid-question can never stall the room', () => {
  const room = pausedRoom();
  room.submitQuestion('alice', 'q');
  room.answerFailed('alice', 'tts down');
  assert.equal(room.professor.status, S.LECTURING);
  assert.equal(room.floorDeadline, null); // timeout state cleared
  // Room remains usable: a new question cycle works.
  room.requestFloor('carol');
  room.submitCheckpoint('carol', CP);
  assert.equal(room.submitQuestion('carol', 'q2').ok, true);
  check(room);
});

test('21j. 10 participants: FIFO order, single holder, no duplicates', () => {
  const room = lecturingRoom();
  const ids = Array.from({ length: 10 }, (_, i) => `p${i}`);
  ids.forEach((id) => { room.joinParticipant(id, `s-${id}`); room.requestFloor(id); });
  assert.equal(room.floor.holder, 'p0');
  assert.deepEqual(room.floor.queue, ids.slice(1));
  check(room);
  // Walk the whole FIFO — each grant is unique, queue shrinks correctly.
  for (const expected of ids.slice(1)) {
    room.releaseFloor(room.floor.holder); check(room);
    assert.equal(room.floor.holder, expected);
  }
  room.releaseFloor('p9');
  assert.equal(room.floor.holder, null);
  assert.equal(room.professor.status, S.LECTURING);
  check(room);
});

test('21k. 5-client scenario: language change while paused preserves queue', () => {
  const room = pausedRoom();
  room.joinParticipant('alice', 's-alice'); // holder must be a known participant
  ['b', 'c', 'd', 'e'].forEach((id) => { room.joinParticipant(id, `s-${id}`); room.requestFloor(id); });
  room.changeLanguage('b', 'ar');
  assert.equal(room.professor.status, S.PAUSED);
  assert.equal(room.floor.holder, 'alice');
  assert.deepEqual(room.floor.queue, ['b', 'c', 'd', 'e']);
  assert.equal(room.interruption.checkpoint.language, 'ar');
  check(room);
});

test('21l. metrics marks produce latencies', () => {
  const room = pausedRoom();
  room.submitQuestion('alice', 'q');
  room.answerReady('a1', { text: 'x' }, 10);
  room.answerTimeExpired('a1');
  const m = room.metricsSummary();
  assert.equal(typeof m.submitToAnswerStartMs, 'number');
  assert.equal(typeof m.answerEndToResumeMs, 'number');
  assert.ok(m.marks.submit <= m.marks.answerStart);
});

test('21m. room stays consistent after a mixed chaos sequence', () => {
  const room = lecturingRoom();
  room.joinParticipant('a', 's1'); room.joinParticipant('b', 's2');
  room.requestFloor('a'); room.requestFloor('b');
  room.submitCheckpoint('a', CP); check(room);
  room.changeLanguage('a', 'de'); check(room);
  room.participantDisconnected('a'); check(room); // holder offline, grace
  room.joinParticipant('a', 's3'); check(room);   // reconnect
  room.submitQuestion('a', 'q'); check(room);
  room.answerReady('a1', { text: 'x' }, 50); check(room);
  const snap = room.snapshot();                    // late-join snapshot mid-answer
  assert.equal(snap.professor.status, 'ANSWERING');
  assert.equal(snap.language.roomLanguage, 'de');
  room.answerTimeExpired('a1'); check(room);
  assert.equal(room.floor.holder, 'b');
});

// ---------------------------------------------------------------------------
// NCIP Slice 5b — THINKING generation timeout
// ---------------------------------------------------------------------------

test('22a. submitQuestion arms a 60s generation deadline', () => {
  const room = pausedRoom();
  room.submitQuestion('alice', 'q');
  const d = room.thinkingDeadline;
  assert.equal(d.holder, 'alice');
  assert.equal(d.token, 'gen1');
  assert.equal(room.THINKING_TIMEOUT_MS, 60000);
  assert.ok(d.expiresAt > Date.now());
  check(room);
});

test('22b. answer start disarms the generation timeout', () => {
  const room = pausedRoom();
  room.submitQuestion('alice', 'q');
  room.answerReady('a1', { text: 'x' }, 100);
  assert.equal(room.thinkingDeadline, null);
  assert.deepEqual(room.thinkingTimeoutExpired('gen1', Date.now() + 99999), []);
  check(room);
});

test('22c. normal generation failure disarms the timeout', () => {
  const room = pausedRoom();
  room.submitQuestion('alice', 'q');
  room.answerFailed('alice', 'boom');
  assert.equal(room.thinkingDeadline, null);
  assert.equal(room.professor.status, S.LECTURING);
});

test('22d. thinking timeout with empty queue resumes from canonical checkpoint', () => {
  const room = pausedRoom();
  room.submitQuestion('alice', 'q');
  const fx = room.thinkingTimeoutExpired('gen1', room.thinkingDeadline.expiresAt + 1);
  assert.equal(room.floor.holder, null);
  const resume = fx.find((e) => e.event === 'lecture-control' && e.data.action === 'resume');
  assert.equal(resume.data.checkpoint.segmentIndex, 2);
  assert.equal(room.professor.status, S.LECTURING);
  assert.ok(events(fx).includes('floor-question-error'));
  check(room);
});

test('22e. thinking timeout with queued participant grants next holder', () => {
  const room = pausedRoom();
  room.requestFloor('bob');
  room.submitQuestion('alice', 'q');
  const fx = room.thinkingTimeoutExpired('gen1', room.thinkingDeadline.expiresAt + 1);
  assert.equal(room.floor.holder, 'bob');
  assert.equal(room.professor.status, S.PAUSED);
  assert.ok(lectureCtl(fx).includes('answer-error'));
  assert.ok(lectureCtl(fx).includes('pause-for-floor'));
  assert.ok(!lectureCtl(fx).includes('resume'));
  check(room);
});

test('22f. late answer after timeout cannot resurrect ANSWERING', () => {
  const room = pausedRoom();
  room.submitQuestion('alice', 'q');
  room.thinkingTimeoutExpired('gen1', room.thinkingDeadline.expiresAt + 1); // recovered
  // The hung LLM finally responds — wrong generation, must be ignored.
  assert.equal(room.isActiveGeneration('gen1'), false);
  assert.deepEqual(room.answerReady('a-late', { text: 'stale' }, 100), []);
  assert.equal(room.professor.status, S.LECTURING);
  check(room);
});

test('22g. stale timeout token cannot kill the CURRENT generation', () => {
  const room = pausedRoom();
  room.requestFloor('bob');
  room.submitQuestion('alice', 'q1');
  room.thinkingTimeoutExpired('gen1', room.thinkingDeadline.expiresAt + 1); // bob granted
  room.submitCheckpoint('bob', CP);
  room.submitQuestion('bob', 'q2'); // gen2 armed
  // Alice's old timer fires again with her token — no-op.
  assert.deepEqual(room.thinkingTimeoutExpired('gen1', Date.now() + 99999), []);
  assert.equal(room.professor.status, S.THINKING);
  assert.equal(room.thinkingDeadline.token, 'gen2');
  assert.equal(room.isActiveGeneration('gen2'), true);
  check(room);
});

test('22h. premature thinking-timeout fire is a no-op', () => {
  const room = pausedRoom();
  room.submitQuestion('alice', 'q');
  assert.deepEqual(room.thinkingTimeoutExpired('gen1', room.thinkingDeadline.expiresAt - 1), []);
  assert.equal(room.professor.status, S.THINKING);
});

test('22i. duplicate timeout firing cannot recover twice', () => {
  const room = pausedRoom();
  room.submitQuestion('alice', 'q');
  room.thinkingTimeoutExpired('gen1', room.thinkingDeadline.expiresAt + 1);
  assert.deepEqual(room.thinkingTimeoutExpired('gen1', Date.now() + 99999), []);
  assert.equal(room.professor.status, S.LECTURING);
});

test('22j. THINKING survives holder disconnect; timeout still recovers', () => {
  const room = pausedRoom();
  room.joinParticipant('alice', 's1');
  room.submitQuestion('alice', 'q');
  room.participantDisconnected('alice'); // holder offline, question in flight
  check(room); // still THINKING, deadline armed — invariant holds
  const fx = room.expireGrace('alice');    // grace expiry removes participant only
  assert.equal(room.professor.status, S.THINKING);
  const fx2 = room.thinkingTimeoutExpired('gen1', room.thinkingDeadline.expiresAt + 1);
  assert.ok(lectureCtl(fx2).includes('resume'));
  assert.equal(room.professor.status, S.LECTURING);
  check(room);
});

// ---------------------------------------------------------------------------
// Late-join during uninterrupted LECTURING (playback position tracking)
// ---------------------------------------------------------------------------

test('23a. playback report flips IDLE -> LECTURING and feeds snapshot', () => {
  const room = new NcipRoom('lj');
  room.joinParticipant('alice', 's1');
  const fx = room.updatePlayback('alice', { lectureId: 'Lecture_1', segmentIndex: 0, playbackOffsetMs: 0 });
  assert.equal(room.professor.status, S.LECTURING);
  assert.equal(room.lectureActive, true);
  assert.ok(events(fx).includes('floor-state'));
  const snap = room.snapshot();
  assert.equal(snap.professor.status, 'LECTURING');
  assert.equal(snap.lecture.active, true);
  assert.equal(snap.lecture.lectureId, 'Lecture_1');
  assert.equal(snap.lecture.segmentIndex, 0);
});

test('23b. late-join snapshot mid-lecture reports current segment + elapsed offset', () => {
  const room = lecturingRoom();
  room.updatePlayback('alice', { lectureId: 'Lecture_1', segmentIndex: 7, playbackOffsetMs: 0 }, 10000);
  // Snapshot taken 4.2s after the segment started -> projected offset.
  const realNow = Date.now;
  Date.now = () => 14200;
  try {
    const snap = room.snapshot();
    assert.equal(snap.lecture.segmentIndex, 7);
    assert.equal(snap.lecture.playbackOffsetMs, 4200); // never seg 0 / offset 0
    assert.equal(snap.lecture.language, room.language.roomLanguage);
  } finally { Date.now = realNow; }
  check(room);
});

test('23c. floor checkpoint still takes precedence over playback report', () => {
  const room = lecturingRoom();
  room.updatePlayback('alice', { lectureId: 'Lecture_1', segmentIndex: 5 });
  room.requestFloor('alice');
  room.submitCheckpoint('alice', CP); // canonical cp = seg 2 @4500
  // cp must win over the newer playback report (seg 5).
  const snap = room.snapshot();
  assert.equal(snap.lecture.segmentIndex, 2);
  assert.equal(snap.lecture.playbackOffsetMs, 4500);
});

test('23d. endLecture clears live position; snapshot no longer offers a segment', () => {
  const room = lecturingRoom();
  room.updatePlayback('alice', { lectureId: 'Lecture_1', segmentIndex: 9 });
  const fx = room.endLecture('alice');
  assert.equal(room.professor.status, S.IDLE);
  assert.equal(room.lectureActive, false);
  const snap = room.snapshot();
  assert.equal(snap.lecture.active, false);
  assert.equal(snap.lecture.segmentIndex, null);
  assert.ok(events(fx).includes('floor-state'));
  check(room);
});

test('23e. malformed playback reports are ignored', () => {
  const room = new NcipRoom('lj');
  assert.deepEqual(room.updatePlayback('x', null), []);
  assert.deepEqual(room.updatePlayback('x', { lectureId: 'L' }), []);
  assert.deepEqual(room.updatePlayback('x', { lectureId: 5, segmentIndex: 1 }), []);
  assert.equal(room.playback, null);
});

test('23f. playback report during PAUSED updates position without unpausing', () => {
  const room = pausedRoom();
  const fx = room.updatePlayback('alice', { lectureId: 'Lecture_1', segmentIndex: 3 });
  assert.equal(room.professor.status, S.PAUSED);
  assert.deepEqual(fx, []);
  check(room);
});

test('23g. language-change broadcast carries authoritative segment hint', () => {
  const room = lecturingRoom();
  room.updatePlayback('alice', { lectureId: 'Lecture_1', segmentIndex: 6 });
  const r = room.changeLanguage('x', 'ar');
  const lc = r.effects.find((e) => e.event === 'lecture-control');
  assert.equal(lc.data.segmentIndex, 6);
});

test('23h. language-change prefers the canonical checkpoint while paused', () => {
  const room = pausedRoom(); // cp seg 2
  const r = room.changeLanguage('x', 'fr');
  const lc = r.effects.find((e) => e.event === 'lecture-control');
  assert.equal(lc.data.segmentIndex, 2);
});
