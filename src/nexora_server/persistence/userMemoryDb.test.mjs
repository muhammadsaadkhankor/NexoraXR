import test from 'node:test';
import assert from 'node:assert/strict';
import { newDb } from 'pg-mem';
import { initUserMemoryDb, persist, queries, dbAvailable } from './userMemoryDb.mjs';
import {
  createUserMemoryStore, recordLectureJoin, recordTopicSeen, recordTopicMissed,
  recordUserQuestion, recordUserClarification, recordUserReexplanation,
  getUserLearningSummary,
} from '../agent/userLearningMemory.mjs';

// pg-mem adapts Postgres in-process — same SQL, no server required.
function makePgMemPool() {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  return new Pool();
}

const settle = () => new Promise((r) => setTimeout(r, 50)); // let queued writes drain

test('persistence round-trip: writes land, reload rebuilds summary', async () => {
  const p = makePgMemPool();
  await initUserMemoryDb(p);
  assert.equal(dbAvailable(), true);

  const store = createUserMemoryStore();
  const LID = 'Lecture_1';
  // User A: present for t0..t2, asks twice on t2 (one flagged), reexplain
  recordLectureJoin(store, 'A', LID, 'runA');
  for (const t of ['t0', 't1', 't2']) recordTopicSeen(store, 'A', LID, 'runA', t);
  recordUserQuestion(store, 'A', LID, 'runA', { topicId: 't2', segmentId: 5, question: 'linear vs non-linear?', answer: 'a1' });
  recordUserQuestion(store, 'A', LID, 'runA', { topicId: 't2', segmentId: 6, question: 'again?', answer: 'a2' });
  recordUserClarification(store, 'A', LID, 'runA', 't2');
  recordUserClarification(store, 'A', LID, 'runA', 't2');
  recordUserReexplanation(store, 'A', LID, 'runA', 't2');
  // User B: late join — missed t0/t1, saw t2, one unflagged question
  recordLectureJoin(store, 'B', LID, 'runA');
  recordTopicMissed(store, 'B', LID, 'runA', 't0');
  recordTopicMissed(store, 'B', LID, 'runA', 't1');
  recordTopicSeen(store, 'B', LID, 'runA', 't2');
  recordUserQuestion(store, 'B', LID, 'runA', { topicId: 't2', segmentId: 6, question: 'B question', answer: 'aB' });
  await settle();

  // Raw rows sanity check
  const qs = await p.query('SELECT * FROM user_question_memory ORDER BY participant_id, id');
  assert.equal(qs.rows.length, 3);
  assert.equal(qs.rows[0].participant_id, 'A');
  assert.equal(qs.rows[0].question, 'linear vs non-linear?');
  const sess = await p.query('SELECT * FROM user_lecture_sessions');
  assert.equal(sess.rows.length, 2); // A and B, one run each
  const top = await p.query(
    `SELECT clarification_count, reexplained, seen FROM user_topic_memory
     WHERE participant_id='A' AND topic_id='t2'`);
  assert.equal(top.rows[0].clarification_count, 2);
  assert.equal(top.rows[0].reexplained, true);
  const topB = await p.query(
    `SELECT missed, seen FROM user_topic_memory WHERE participant_id='B' AND topic_id='t0'`);
  assert.equal(topB.rows[0].missed, true);
  assert.equal(topB.rows[0].seen, false);

  // Reload: hydrate fresh RAM store from the same DB -> same summaries
  const store2 = createUserMemoryStore();
  const { hydrateUserMemory } = await import('../agent/userLearningMemory.mjs');
  await hydrateUserMemory(store2, 'A', async (pid) => queries.loadUser(p, pid));
  await hydrateUserMemory(store2, 'B', async (pid) => queries.loadUser(p, pid));
  const sA = getUserLearningSummary(store2, 'A', LID);
  const sB = getUserLearningSummary(store2, 'B', LID);
  assert.deepEqual(sA.topicsSeen.sort(), ['t0', 't1', 't2']);
  assert.equal(sA.questionCount, 2);
  assert.equal(sA.clarificationCountByTopic.t2, 2);
  assert.deepEqual(sA.reexplainedTopics, ['t2']);
  assert.deepEqual(sB.topicsMissed, ['t0', 't1']);
  assert.deepEqual(sB.topicsSeen, ['t2']);
  assert.equal(sB.questionCount, 1);
});

test('restart -> second run, both persisted and reloadable', async () => {
  const p = makePgMemPool();
  await initUserMemoryDb(p);
  const store = createUserMemoryStore();
  recordLectureJoin(store, 'A', 'Lecture_1', 'runA');
  recordUserQuestion(store, 'A', 'Lecture_1', 'runA', { topicId: 't0', segmentId: 0, question: 'runA q', answer: 'a' });
  recordLectureJoin(store, 'A', 'Lecture_1', 'runB'); // restart
  recordUserQuestion(store, 'A', 'Lecture_1', 'runB', { topicId: 't0', segmentId: 0, question: 'runB q', answer: 'b' });
  await settle();
  const qs = await p.query('SELECT * FROM user_question_memory ORDER BY id');
  assert.equal(qs.rows.length, 2);
  assert.equal(qs.rows[0].run_id, 'runA');
  assert.equal(qs.rows[1].run_id, 'runB');
});

test('DB unavailable: writes are skipped, RAM memory unaffected', async () => {
  // Fresh module state w/o adapter + no DATABASE_URL -> degraded noop.
  const { initUserMemoryDb, persist, dbAvailable } = await import('./userMemoryDb.mjs?x=noop');
  delete process.env.DATABASE_URL;
  await initUserMemoryDb();
  assert.equal(dbAvailable(), false);
  // persist() must not throw when pool is null
  persist(() => { throw new Error('should not run'); });
  const store = createUserMemoryStore();
  recordLectureJoin(store, 'A', 'Lecture_1', 'r1');
  recordUserQuestion(store, 'A', 'Lecture_1', 'r1', { topicId: 't1', segmentId: 1, question: 'q', answer: 'a' });
  assert.equal(getUserLearningSummary(store, 'A', 'Lecture_1').questionCount, 1);
});

test('latencies: RAM update << tick; DB write does not block caller', async () => {
  const p = makePgMemPool();
  await initUserMemoryDb(p);
  const store = createUserMemoryStore();
  let t0 = performance.now();
  for (let i = 0; i < 1000; i++) {
    recordUserQuestion(store, 'A', 'Lecture_1', 'r1', { topicId: 't1', segmentId: 1, question: `q${i}`, answer: 'a' });
  }
  const ramMs = performance.now() - t0;
  assert.ok(ramMs < 1000, `RAM updates too slow: ${ramMs}ms`); // real expectation: few ms
});
