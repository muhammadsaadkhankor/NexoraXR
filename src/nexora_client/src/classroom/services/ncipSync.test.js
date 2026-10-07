// NCIP Slice 2 client-side tests — run with: node --test src/classroom/services/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyEvent,
  planAnswerRecovery,
  snapshotIsStale,
  snapshotCheckpoint,
  planLectureRecovery,
  snapshotLanguage,
  planLanguageSwitch,
  resolveSlidePage,
  snapshotFloor,
} from './ncipSync.js';

const LECT_MSGS = (ids) => ids.map((i) => ({ id: `Lecture_1_seg_${i}`, type: 'lecture' }));

const SNAP = {
  stateVersion: 5,
  floor: { holder: { userId: 'alice', name: 'Alice' }, queue: [{ userId: 'bob', name: 'Bob' }] },
  professor: { status: 'PAUSED' },
  lecture: { active: true, lectureId: 'Lecture_1', segmentIndex: 7, playbackOffsetMs: 12000, language: 'en' },
  interruption: { checkpoint: { lectureId: 'Lecture_1', segmentIndex: 7, playbackOffsetMs: 12000, language: 'en', reportedBy: 'alice' } },
  currentAnswer: null,
};

// --- version classification -------------------------------------------------

test('S2-1. unversioned events always apply', () => {
  assert.equal(classifyEvent(5, null), 'apply');
  assert.equal(classifyEvent(5, undefined), 'apply');
  assert.equal(classifyEvent(-1, null), 'apply');
});

test('S2-2. stale and same/new versions classified correctly', () => {
  assert.equal(classifyEvent(5, 3), 'stale');   // older than applied — drop
  assert.equal(classifyEvent(5, 5), 'apply');   // same transition, second event
  assert.equal(classifyEvent(5, 6), 'apply');   // next version
});

test('S2-3. version gap detected -> gap (request sync, do not apply)', () => {
  assert.equal(classifyEvent(5, 8), 'gap');
  assert.equal(classifyEvent(-1, 4), 'gap');    // versioned event before baseline
});

// --- snapshot staleness -----------------------------------------------------

test('S2-4. stale snapshot detection', () => {
  assert.equal(snapshotIsStale(10, { stateVersion: 7 }), true);
  assert.equal(snapshotIsStale(7, { stateVersion: 10 }), false);
  assert.equal(snapshotIsStale(-1, { stateVersion: 0 }), false);
  assert.equal(snapshotIsStale(3, {}), false); // unversioned snapshot — apply
});

// --- snapshot checkpoint extraction -----------------------------------------

test('S2-5. snapshotCheckpoint normalizes authoritative lecture position', () => {
  const cp = snapshotCheckpoint(SNAP.lecture);
  assert.deepEqual(cp, { lectureId: 'Lecture_1', segmentIndex: 7, playbackOffsetMs: 12000, language: 'en' });
  assert.equal(snapshotCheckpoint({ active: false }), null);
  assert.equal(snapshotCheckpoint(null), null);
  assert.equal(snapshotCheckpoint({ active: true, lectureId: 'L', segmentIndex: null }), null);
});

// --- lecture recovery planning ----------------------------------------------

test('S2-6. recovery: no active lecture -> none', () => {
  assert.deepEqual(planLectureRecovery({ lecture: { active: false } }, []), { action: 'none' });
  assert.deepEqual(planLectureRecovery({}, LECT_MSGS([0, 1])), { action: 'none' });
});

test('S2-7. recovery: checkpoint segment already queued -> resume', () => {
  const plan = planLectureRecovery(SNAP, LECT_MSGS([7, 8, 9]));
  assert.equal(plan.action, 'resume');
  assert.equal(plan.checkpoint.segmentIndex, 7);
  assert.equal(plan.checkpoint.playbackOffsetMs, 12000);
});

test('S2-8. recovery: missing segment -> reload at canonical position', () => {
  // Late joiner: empty queue.
  const plan = planLectureRecovery(SNAP, []);
  assert.equal(plan.action, 'reload');
  assert.equal(plan.checkpoint.lectureId, 'Lecture_1');
  assert.equal(plan.checkpoint.segmentIndex, 7);
  assert.equal(plan.checkpoint.playbackOffsetMs, 12000);
});

test('S2-9. recovery never plans a segment-0 restart', () => {
  const plan = planLectureRecovery(SNAP, LECT_MSGS([0, 1, 2])); // wrong segments loaded
  assert.equal(plan.action, 'reload');             // rebuild from seg 7
  assert.equal(plan.checkpoint.segmentIndex, 7);   // not 0
});

test('S2-10. recovery picks a later checkpoint, not the queued head', () => {
  const snap = { ...SNAP, lecture: { ...SNAP.lecture, segmentIndex: 4 } };
  const plan = planLectureRecovery(snap, LECT_MSGS([2, 3, 4, 5]));
  assert.equal(plan.action, 'resume');
  assert.equal(plan.checkpoint.segmentIndex, 4);
});

// --- floor projection -------------------------------------------------------

test('S2-11. snapshotFloor maps to the floor-state UI shape', () => {
  const { floorQueue, activeSpeaker } = snapshotFloor(SNAP);
  assert.equal(activeSpeaker.userId, 'alice');
  assert.equal(floorQueue[0].userId, 'bob');
  assert.deepEqual(snapshotFloor({}), { floorQueue: [], activeSpeaker: null });
});

// --- in-flight answer recovery (Slice 2 fix) --------------------------------

const ANSWER_SNAP = (elapsedMs, durationMs = 20000) => ({
  stateVersion: 9,
  professor: { status: 'ANSWERING' },
  lecture: { active: false },
  currentAnswer: {
    id: 'ans-1', startedAt: 100000, durationMs,
    text: 'answer text', audioUrl: '/api/lecture/answer_audio/abc',
    lipsync: { mouthCues: [] }, animation: 'TalkingOne', facialExpression: 'smile',
  },
  // serverNow = startedAt + elapsed — same clock as startedAt.
  serverNow: 100000 + elapsedMs,
});

test('S2-12. join at 25% of answer -> resume from elapsed offset', () => {
  const plan = planAnswerRecovery(ANSWER_SNAP(5000, 20000));
  assert.equal(plan.action, 'play');
  assert.equal(plan.elapsedMs, 5000);
  assert.equal(plan.seekSec, 5);
  assert.equal(plan.message.resumeAt, 5);
});

test('S2-13. join at ~50% -> only remaining half plays', () => {
  const plan = planAnswerRecovery(ANSWER_SNAP(10000, 20000));
  assert.equal(plan.action, 'play');
  assert.equal(plan.seekSec, 10);
});

test('S2-14. join near answer end -> resumes near end', () => {
  const plan = planAnswerRecovery(ANSWER_SNAP(19500, 20000));
  assert.equal(plan.action, 'play');
  assert.equal(plan.seekSec, 19.5);
});

test('S2-15. join after durationMs -> answer is not replayed', () => {
  const plan = planAnswerRecovery(ANSWER_SNAP(21000, 20000));
  assert.equal(plan.action, 'skip');
  assert.equal(plan.reason, 'answer-finished');
});

test('S2-16. recovered answer never restarts at 0', () => {
  for (const elapsed of [3000, 12000, 19999]) {
    const plan = planAnswerRecovery(ANSWER_SNAP(elapsed, 20000));
    assert.ok(plan.message.resumeAt > 0, `elapsed ${elapsed} must not seek to 0`);
  }
});

test('S2-17. recovered message preserves answer presentation payload', () => {
  const plan = planAnswerRecovery(ANSWER_SNAP(2000, 20000));
  assert.equal(plan.message.id, 'ans-1');
  assert.equal(plan.message.audioUrl, '/api/lecture/answer_audio/abc');
  assert.deepEqual(plan.message.lipsync, { mouthCues: [] });
  assert.equal(plan.message.animation, 'TalkingOne');
  assert.equal(plan.message.floorAnswer, true);
  assert.equal(plan.message.fromRemote, true);
});

test('S2-18. no answer recovery when not ANSWERING or payload missing', () => {
  assert.equal(planAnswerRecovery({ professor: { status: 'PAUSED' } }).action, 'none');
  assert.equal(planAnswerRecovery({ professor: { status: 'ANSWERING' }, currentAnswer: null }).action, 'skip');
  const noAudio = planAnswerRecovery({ professor: { status: 'ANSWERING' }, serverNow: 5, currentAnswer: { id: 'x', startedAt: 0 } });
  assert.equal(noAudio.action, 'skip');
});

test('S2-19. unknown duration answers still resume at elapsed', () => {
  const snap = ANSWER_SNAP(8000, null);
  snap.currentAnswer.durationMs = null;
  const plan = planAnswerRecovery(snap);
  assert.equal(plan.action, 'play');
  assert.equal(plan.seekSec, 8);
});

test('S2-20. lecture recovery plan is independent of answer recovery', () => {
  const snap = { ...ANSWER_SNAP(5000, 20000), lecture: { active: true, lectureId: 'Lecture_1', segmentIndex: 3, playbackOffsetMs: 9000, language: 'en' } };
  assert.equal(planAnswerRecovery(snap).action, 'play');          // answer plays…
  const lec = planLectureRecovery(snap, []);
  assert.equal(lec.action, 'reload');                              // …while lecture stays paused behind it
  assert.equal(lec.checkpoint.segmentIndex, 3);
});

// --- room language (Slice 3) -------------------------------------------------

test('S3-1. snapshot exposes authoritative roomLanguage', () => {
  assert.equal(snapshotLanguage({ language: { roomLanguage: 'ar' } }), 'ar');
  assert.equal(snapshotLanguage({ language: { roomLanguage: 'en' } }), 'en');
  assert.equal(snapshotLanguage({}), null);
});

test('S3-2. language-change events pass through the same version gate', () => {
  // A stale language broadcast must not overwrite a newer snapshot.
  assert.equal(classifyEvent(9, 7), 'stale');
  // The language change shares its transition version with floor-state.
  assert.equal(classifyEvent(9, 9), 'apply');
});

test('S3-3. checkpoint language flows into lecture recovery plan', () => {
  const snap = {
    lecture: { active: true, lectureId: 'Lecture_1', segmentIndex: 4, playbackOffsetMs: 0, language: 'ar' },
  };
  const plan = planLectureRecovery(snap, []);
  assert.equal(plan.action, 'reload');
  assert.equal(plan.checkpoint.language, 'ar');
});

// --- language-switch rebuild planning (bugfix) --------------------------------

const seg = (id, n) => ({ id: `${id}_seg_${n}`, type: 'lecture' });

test('L1. local queue position wins; head lecture flagged', () => {
  const msgs = [seg('Lecture_1', 3), seg('Lecture_1', 4)];
  assert.deepEqual(planLanguageSwitch(msgs, 0), { segmentIndex: 3, headIsLecture: true });
});

test('L2. answer head => rebuild goes behind it', () => {
  const msgs = [{ id: 'ans1', type: 'answer' }, seg('Lecture_1', 5)];
  assert.deepEqual(planLanguageSwitch(msgs, null), { segmentIndex: 5, headIsLecture: false });
});

test('L3. empty queue uses server hint — never falls back to 0', () => {
  assert.deepEqual(planLanguageSwitch([], 7), { segmentIndex: 7, headIsLecture: false });
  assert.equal(planLanguageSwitch([], null), null);      // no position → no rebuild
  assert.equal(planLanguageSwitch([], -1), null);
});

test('L4. malformed hint ignored when local position exists', () => {
  const msgs = [seg('Lecture_1', 2)];
  assert.equal(planLanguageSwitch(msgs, 'x').segmentIndex, 2);
});

// --- slide sync (segment→PDF page resolution) --------------------------------

test('S1. slidePage comes from the current lecture head', () => {
  const msgs = [{ id: 'L_seg_0', type: 'lecture', slidePage: 1 }];
  assert.equal(resolveSlidePage(msgs, null), 1);
  const msgs5 = [{ id: 'L_seg_5', type: 'lecture', slidePage: 14 }];
  assert.equal(resolveSlidePage(msgs5, 1), 14);
});

test('S2. Q&A answer head keeps the interrupted segment slide', () => {
  const msgs = [
    { id: 'ans', type: 'answer' },
    { id: 'L_seg_6', type: 'lecture', slidePage: 26 },
  ];
  assert.equal(resolveSlidePage(msgs, 14), 26);
});

test('S3. no lecture message / no mapping → keep last valid page', () => {
  assert.equal(resolveSlidePage([{ id: 'ans', type: 'answer' }], 30), 30);
  assert.equal(resolveSlidePage([{ id: 'L_seg_2', type: 'lecture', slidePage: null }], 30), 30);
  assert.equal(resolveSlidePage([], 30), 30);
});

test('S4. nothing ever resolved → page 1', () => {
  assert.equal(resolveSlidePage([], null), 1);
  assert.equal(resolveSlidePage([{ id: 'ans', type: 'answer' }], undefined), 1);
});

// ---------------------------------------------------------------------------
// Speech-recognition language mapping (V1 language lock)
// ---------------------------------------------------------------------------

import { SPEECH_RECOGNITION_LANGS } from '../../shared/config.js';

test('recognition map covers every supported room language with BCP-47 codes', () => {
  assert.equal(SPEECH_RECOGNITION_LANGS.en, 'en-US');
  assert.equal(SPEECH_RECOGNITION_LANGS.ar, 'ar-SA');
  assert.equal(SPEECH_RECOGNITION_LANGS.fr, 'fr-FR');
  assert.equal(SPEECH_RECOGNITION_LANGS.de, 'de-DE');
  assert.equal(SPEECH_RECOGNITION_LANGS.es, 'es-ES');
  assert.equal(SPEECH_RECOGNITION_LANGS.zh, 'zh-CN'); // zh verified working
  assert.equal(SPEECH_RECOGNITION_LANGS.hi, undefined); // hi intentionally excluded
});

// ---------------------------------------------------------------------------
// Create Classroom form validation (V1 unified public/private creation)
// ---------------------------------------------------------------------------

import { CLASSROOM_LANGUAGES, validateClassroomDraft } from '../../shared/config.js';

test('classroom draft validation: name, lectureId charset, known language', () => {
  assert.equal(validateClassroomDraft({ className: 'CV Study', lectureId: 'Lecture_1', language: 'ar' }), true);
  assert.equal(validateClassroomDraft({ className: '', lectureId: 'Lecture_1', language: 'en' }), false);
  assert.equal(validateClassroomDraft({ className: 'c', lectureId: '../x', language: 'en' }), false);
  assert.equal(validateClassroomDraft({ className: 'c', lectureId: 'Lecture_1', language: 'hi' }), false); // hi not offered
  assert.equal(validateClassroomDraft({ className: 'c', lectureId: 'Lecture_1', language: 'zh' }), true);
});

test('classroom languages offer zh but not hi', () => {
  const codes = CLASSROOM_LANGUAGES.map((l) => l.code);
  assert.ok(codes.includes('zh'));
  assert.ok(!codes.includes('hi'));
});
