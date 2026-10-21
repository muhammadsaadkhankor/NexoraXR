import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createProfessorMemory, resetProfessorMemory, recordTopicTaught,
  recordQuestion, incrementClarification, recordReexplanation,
  getTopicClarificationCount, hasTopicBeenReexplained, getProfessorMemorySummary,
} from './professorMemory.mjs';

test('new memory is empty', () => {
  const m = createProfessorMemory('Lecture_1');
  assert.equal(m.lectureId, 'Lecture_1');
  assert.deepEqual(m.topicsTaught, []);
  assert.deepEqual(m.questions, []);
  assert.deepEqual(m.reexplainedTopics, []);
  assert.deepEqual(m.clarificationCountByTopic, {});
  assert.equal(m.lastInteraction, null);
});

test('recordTopicTaught adds once, never duplicates', () => {
  const m = createProfessorMemory('L');
  recordTopicTaught(m, 't1');
  recordTopicTaught(m, 't1');
  recordTopicTaught(m, 't2');
  assert.deepEqual(m.topicsTaught, ['t1', 't2']);
});

test('recordQuestion stores full entry and updates lastInteraction', () => {
  const m = createProfessorMemory('L');
  recordQuestion(m, { participantId: 'p1', topicId: 't2', segmentId: 2, question: 'what is X?', answer: 'X is...' });
  assert.equal(m.questions.length, 1);
  const q = m.questions[0];
  assert.equal(q.participantId, 'p1');
  assert.equal(q.topicId, 't2');
  assert.equal(q.segmentId, 2);
  assert.equal(q.question, 'what is X?');
  assert.equal(q.answer, 'X is...');
  assert.equal(m.lastInteraction.type, 'question_answered');
  assert.equal(m.lastInteraction.topicId, 't2');
});

test('clarification count increments per topic', () => {
  const m = createProfessorMemory('L');
  incrementClarification(m, 't2');
  incrementClarification(m, 't2');
  incrementClarification(m, 't3');
  assert.equal(getTopicClarificationCount(m, 't2'), 2);
  assert.equal(getTopicClarificationCount(m, 't3'), 1);
  assert.equal(getTopicClarificationCount(m, 't9'), 0);
});

test('re-explain recorded once; hasTopicBeenReexplained reflects it', () => {
  const m = createProfessorMemory('L');
  assert.equal(hasTopicBeenReexplained(m, 't2'), false);
  recordReexplanation(m, 't2');
  recordReexplanation(m, 't2');
  assert.deepEqual(m.reexplainedTopics, ['t2']);
  assert.equal(hasTopicBeenReexplained(m, 't2'), true);
  assert.equal(m.lastInteraction.type, 'reexplanation');
});

test('lastInteraction tracks the latest important event', () => {
  const m = createProfessorMemory('L');
  recordTopicTaught(m, 't1');
  assert.equal(m.lastInteraction.type, 'topic_taught');
  recordQuestion(m, { question: 'q?', answer: 'a.' });
  assert.equal(m.lastInteraction.type, 'question_answered');
  recordReexplanation(m, 't1');
  assert.equal(m.lastInteraction.type, 'reexplanation');
});

test('summary is compact and snapshot-safe', () => {
  const m = createProfessorMemory('L1');
  recordTopicTaught(m, 't0');
  recordQuestion(m, { topicId: 't0', question: 'q', answer: 'a' });
  incrementClarification(m, 't0');
  recordReexplanation(m, 't0');
  const s = getProfessorMemorySummary(m);
  assert.equal(s.lectureId, 'L1');
  assert.equal(s.topicsTaughtCount, 1);
  assert.equal(s.questionCount, 1);
  assert.equal(s.clarificationCountByTopic.t0, 1);
  assert.deepEqual(s.reexplainedTopics, ['t0']);
  assert.equal(s.lastInteractionType, 'reexplanation');
});

test('reset clears previous lecture memory', () => {
  const m = createProfessorMemory('L1');
  recordTopicTaught(m, 't0');
  recordQuestion(m, { question: 'q', answer: 'a' });
  const fresh = resetProfessorMemory('L1');
  assert.deepEqual(fresh, createProfessorMemory('L1'));
});

test('question list is bounded', () => {
  const m = createProfessorMemory('L');
  for (let i = 0; i < 60; i++) recordQuestion(m, { question: `q${i}`, answer: 'a' });
  assert.equal(m.questions.length, 50);
  assert.equal(m.questions[0].question, 'q10');
});

test('deterministic: same inputs -> same shape (minus timestamps)', () => {
  const build = () => {
    const m = createProfessorMemory('L');
    recordTopicTaught(m, 't1');
    recordQuestion(m, { participantId: 'p', topicId: 't1', segmentId: 0, question: 'q', answer: 'a', timestamp: 0 });
    incrementClarification(m, 't1');
    recordReexplanation(m, 't1');
    return m;
  };
  assert.deepEqual(build(), build());
});
