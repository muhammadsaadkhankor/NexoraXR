import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createUserMemoryStore, createUserMemory, recordLectureJoin, recordTopicSeen,
  recordTopicMissed, recordUserQuestion, recordUserClarification,
  recordUserReexplanation, getUserLectureMemory, getUserQuestionHistory,
  getUserDifficultyTopics, getUserLearningSummary, hydrateUserMemory,
} from './userLearningMemory.mjs';

const LID = 'Lecture_1';

test('new user memory is empty', () => {
  const m = createUserMemory('p1');
  assert.equal(m.participantId, 'p1');
  assert.equal(m.lectures.size, 0);
});

test('lecture join recorded once per run; restart creates a second run', () => {
  const store = createUserMemoryStore();
  recordLectureJoin(store, 'A', LID, 'runA');
  recordLectureJoin(store, 'A', LID, 'runA'); // duplicate join — same run
  recordLectureJoin(store, 'A', LID, 'runB'); // restart -> new run
  const m = store.get('A');
  assert.equal(m.lectures.size, 2);
  assert.ok(m.lectures.has('runA') && m.lectures.has('runB'));
});

test('topics seen tracked per run; missed marks join-time only', () => {
  const store = createUserMemoryStore();
  // A joined before t0 — sees everything
  recordLectureJoin(store, 'A', LID, 'r1');
  for (const t of ['t0', 't1', 't2']) recordTopicSeen(store, 'A', LID, 'r1', t);
  // B joins during t2 — t0/t1 already taught -> missed; then sees t2,t3
  recordLectureJoin(store, 'B', LID, 'r1');
  recordTopicMissed(store, 'B', LID, 'r1', 't0');
  recordTopicMissed(store, 'B', LID, 'r1', 't1');
  recordTopicSeen(store, 'B', LID, 'r1', 't2');
  recordTopicSeen(store, 'B', LID, 'r1', 't3');
  const sumA = getUserLearningSummary(store, 'A', LID);
  const sumB = getUserLearningSummary(store, 'B', LID);
  assert.deepEqual(sumA.topicsSeen, ['t0', 't1', 't2']);
  assert.deepEqual(sumA.topicsMissed, []);
  assert.deepEqual(sumB.topicsMissed, ['t0', 't1']);
  assert.deepEqual(sumB.topicsSeen, ['t2', 't3']);
});

test('seen beats missed — reconnect edge cannot strand a false missed', () => {
  const store = createUserMemoryStore();
  recordLectureJoin(store, 'A', LID, 'r1');
  recordTopicMissed(store, 'A', LID, 'r1', 't1');
  recordTopicSeen(store, 'A', LID, 'r1', 't1'); // they actually saw it
  const sum = getUserLearningSummary(store, 'A', LID);
  assert.deepEqual(sum.topicsSeen, ['t1']);
  assert.deepEqual(sum.topicsMissed, []);
});

test('question stores exact question+answer, no duplicates on replay', () => {
  const store = createUserMemoryStore();
  recordLectureJoin(store, 'A', LID, 'r1');
  const e = recordUserQuestion(store, 'A', LID, 'r1',
    { topicId: 't2', segmentId: 5, question: 'linear vs non-linear?', answer: 'Linear is…' });
  assert.equal(e.question, 'linear vs non-linear?');
  assert.equal(e.answer, 'Linear is…');
  const hist = getUserQuestionHistory(store, 'A', LID);
  assert.equal(hist.length, 1);
  assert.equal(hist[0].topicId, 't2');
});

test('clarification counts are per-user and per-topic', () => {
  const store = createUserMemoryStore();
  recordLectureJoin(store, 'A', LID, 'r1');
  recordLectureJoin(store, 'B', LID, 'r1');
  recordUserClarification(store, 'A', LID, 'r1', 't2');
  recordUserClarification(store, 'A', LID, 'r1', 't2');
  const sumA = getUserLearningSummary(store, 'A', LID);
  const sumB = getUserLearningSummary(store, 'B', LID);
  assert.equal(sumA.clarificationCountByTopic.t2, 2);
  assert.equal(sumB.clarificationCountByTopic.t2 ?? 0, 0);
  assert.deepEqual(getUserDifficultyTopics(store, 'A'), [{ topicId: 't2', count: 2 }]);
});

test('reexplain tracked once per user', () => {
  const store = createUserMemoryStore();
  recordLectureJoin(store, 'A', LID, 'r1');
  recordUserReexplanation(store, 'A', LID, 'r1', 't2');
  recordUserReexplanation(store, 'A', LID, 'r1', 't2');
  assert.deepEqual(getUserLearningSummary(store, 'A', LID).reexplainedTopics, ['t2']);
});

test('same-lecture restart preserves both runs independently', () => {
  const store = createUserMemoryStore();
  recordLectureJoin(store, 'A', LID, 'runA');
  recordTopicSeen(store, 'A', LID, 'runA', 't0');
  recordUserQuestion(store, 'A', LID, 'runA', { topicId: 't0', segmentId: 0, question: 'q1', answer: 'a1' });
  recordLectureJoin(store, 'A', LID, 'runB'); // restart
  recordTopicSeen(store, 'A', LID, 'runB', 't0');
  recordUserQuestion(store, 'A', LID, 'runB', { topicId: 't0', segmentId: 0, question: 'q2', answer: 'a2' });
  const hist = getUserQuestionHistory(store, 'A', LID);
  assert.equal(hist.length, 2);
  assert.deepEqual(hist.map((q) => q.question), ['q1', 'q2']);
  assert.deepEqual(new Set(hist.map((q) => q.runId)), new Set(['runA', 'runB']));
});

test('summary aggregates across runs without leaking other lectures', () => {
  const store = createUserMemoryStore();
  recordLectureJoin(store, 'A', LID, 'r1');
  recordUserQuestion(store, 'A', LID, 'r1', { topicId: 't1', segmentId: 1, question: 'q', answer: 'a' });
  recordLectureJoin(store, 'A', 'Lecture_2', 'r2');
  recordTopicSeen(store, 'A', 'Lecture_2', 'r2', 'x0');
  const sum = getUserLearningSummary(store, 'A', LID);
  assert.equal(sum.questionCount, 1);
  assert.deepEqual(sum.topicsSeen, []);
  assert.ok(getUserLearningSummary(store, 'A', 'Lecture_2').topicsSeen.includes('x0'));
  assert.equal(getUserLearningSummary(store, 'A', 'Lecture_9'), null);
});

test('unknown participant -> null summary, empty history', () => {
  const store = createUserMemoryStore();
  assert.equal(getUserLearningSummary(store, 'ghost', LID), null);
  assert.deepEqual(getUserQuestionHistory(store, 'ghost'), []);
});

test('hydrate merges persisted rows into RAM idempotently', async () => {
  const store = createUserMemoryStore();
  const rows = {
    sessions: [{ lecture_id: LID, run_id: 'r1', joined_at: new Date(1000), last_seen_at: new Date(2000) }],
    topics: [
      { lecture_id: LID, run_id: 'r1', topic_id: 't0', seen: true, missed: false, clarification_count: 0, reexplained: false },
      { lecture_id: LID, run_id: 'r1', topic_id: 't2', seen: true, missed: false, clarification_count: 2, reexplained: true },
      { lecture_id: LID, run_id: 'r1', topic_id: 't1', seen: false, missed: true, clarification_count: 0, reexplained: false },
    ],
    questions: [{ lecture_id: LID, run_id: 'r1', topic_id: 't2', segment_id: 5, question: 'q?', answer: 'a.', asked_at: new Date(1500) }],
  };
  await hydrateUserMemory(store, 'A', async () => rows);
  await hydrateUserMemory(store, 'A', async () => rows); // idempotent
  const sum = getUserLearningSummary(store, 'A', LID);
  assert.deepEqual(sum.topicsSeen.sort(), ['t0', 't2']);
  assert.deepEqual(sum.topicsMissed, ['t1']);
  assert.equal(sum.questionCount, 1);
  assert.equal(sum.clarificationCountByTopic.t2, 2);
  assert.deepEqual(sum.reexplainedTopics, ['t2']);
});

test('question list bounded at 100 per run', () => {
  const store = createUserMemoryStore();
  recordLectureJoin(store, 'A', LID, 'r1');
  for (let i = 0; i < 120; i++) {
    recordUserQuestion(store, 'A', LID, 'r1', { topicId: 't0', segmentId: 0, question: `q${i}`, answer: 'a' });
  }
  assert.equal(getUserLectureMemory(store, 'A', 'r1').questions.length, 100);
});
