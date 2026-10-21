// Per-user learning memory (V2.3.x) — RAM-authoritative, lazily hydrated from
// Postgres, and every mutation schedules an async write through
// persistence/userMemoryDb.mjs (never awaited on the lecture hot path).
//
// Identity: existing stable participantId (survives reconnect via the
// session map). NOT persistent across app/browser sessions unless the client
// supplies the same participantId — documented limitation, no auth invented.
//
// Structure per (participantId, runId): the run_id separates Lecture_1 Run A
// from Run B — a restart never overwrites the earlier run's history.

import { persist, queries } from '../persistence/userMemoryDb.mjs';

const MAX_QUESTIONS = 100;

const newLectureMemory = (lectureId, runId) => ({
  lectureId,
  runId,
  joinedAt: Date.now(),
  lastSeenAt: Date.now(),
  topicsSeen: [],
  topicsMissed: [],
  questions: [],
  clarificationCountByTopic: {},
  reexplainedTopics: [],
});

export function createUserMemory(participantId) {
  return { participantId, lectures: new Map() };
}

function getOrCreate(store, participantId) {
  let m = store.get(participantId);
  if (!m) { m = createUserMemory(participantId); store.set(participantId, m); }
  return m;
}

function getRun(memory, lectureId, runId) {
  let lec = memory.lectures.get(runId);
  if (!lec) { lec = newLectureMemory(lectureId, runId); memory.lectures.set(runId, lec); }
  return lec;
}

// ---- spec events -----------------------------------------------------------

export function recordLectureJoin(store, participantId, lectureId, runId) {
  const m = getOrCreate(store, participantId);
  const lec = getRun(m, lectureId, runId);
  lec.lastSeenAt = Date.now(); // no duplicate join row — upsert is by run
  persist((p) => queries.upsertSession(p, { participantId, lectureId, runId, lastSeenAt: lec.lastSeenAt }));
  return lec;
}

export function recordTopicSeen(store, participantId, lectureId, runId, topicId) {
  const lec = getRun(getOrCreate(store, participantId), lectureId, runId);
  if (!lec.topicsSeen.includes(topicId)) lec.topicsSeen.push(topicId);
  // seen wins over missed — a reconnect edge can't strand a false "missed".
  const mi = lec.topicsMissed.indexOf(topicId);
  if (mi >= 0) lec.topicsMissed.splice(mi, 1);
  pushTopic(store, participantId, lec, topicId);
  return lec;
}

export function recordTopicMissed(store, participantId, lectureId, runId, topicId) {
  const lec = getRun(getOrCreate(store, participantId), lectureId, runId);
  if (lec.topicsSeen.includes(topicId) || lec.topicsMissed.includes(topicId)) return lec;
  lec.topicsMissed.push(topicId);
  pushTopic(store, participantId, lec, topicId);
  return lec;
}

export function recordUserQuestion(store, participantId, lectureId, runId, { topicId, segmentId, question, answer }) {
  const lec = getRun(getOrCreate(store, participantId), lectureId, runId);
  const entry = { topicId: topicId ?? null, segmentId: segmentId ?? null,
    question: (question || '').slice(0, 500), answer: (answer || '').slice(0, 2000), timestamp: Date.now() };
  lec.questions.push(entry);
  while (lec.questions.length > MAX_QUESTIONS) lec.questions.shift();
  lec.lastSeenAt = Date.now();
  persist((p) => queries.insertQuestion(p, { participantId, runId, lectureId, ...entry }));
  return entry;
}

export function recordUserClarification(store, participantId, lectureId, runId, topicId) {
  const lec = getRun(getOrCreate(store, participantId), lectureId, runId);
  lec.clarificationCountByTopic[topicId] = (lec.clarificationCountByTopic[topicId] || 0) + 1;
  pushTopic(store, participantId, lec, topicId);
  return lec;
}

export function recordUserReexplanation(store, participantId, lectureId, runId, topicId) {
  const lec = getRun(getOrCreate(store, participantId), lectureId, runId);
  if (!lec.reexplainedTopics.includes(topicId)) lec.reexplainedTopics.push(topicId);
  pushTopic(store, participantId, lec, topicId);
  return lec;
}

// Marks that a shared late-joiner recap covered `coveredSegmentIds` for this
// user (dedupe by covered-set + joinedDuring so the same recap never counts
// twice). RAM-side flag; the authoritative dedupe lives in lectureProgress.
export function recordUserGroupRecap(store, participantId, lectureId, runId,
  { coveredSegmentIds = [], joinedDuringSegmentId = null } = {}) {
  const lec = getRun(getOrCreate(store, participantId), lectureId, runId);
  lec.groupRecaps ||= [];
  const key = `${joinedDuringSegmentId}|${[...coveredSegmentIds].sort((a, b) => a - b).join(',')}`;
  if (lec.groupRecaps.some((r) => r.key === key)) return lec;
  lec.groupRecaps.push({ key, coveredSegmentIds: [...coveredSegmentIds], joinedDuringSegmentId, timestamp: Date.now() });
  return lec;
}

function pushTopic(store, participantId, lec, topicId) {
  persist((p) => queries.upsertTopic(p, {
    participantId, runId: lec.runId, lectureId: lec.lectureId, topicId,
    seen: lec.topicsSeen.includes(topicId),
    missed: lec.topicsMissed.includes(topicId),
    clarificationCount: lec.clarificationCountByTopic[topicId] || 0,
    reexplained: lec.reexplainedTopics.includes(topicId),
  }));
}

// ---- reads -----------------------------------------------------------------

export function getUserLectureMemory(store, participantId, runId) {
  return store.get(participantId)?.lectures.get(runId) ?? null;
}

export function getUserQuestionHistory(store, participantId, lectureId = null) {
  const m = store.get(participantId);
  if (!m) return [];
  const out = [];
  for (const lec of m.lectures.values()) {
    if (lectureId && lec.lectureId !== lectureId) continue;
    out.push(...lec.questions.map((q) => ({ ...q, runId: lec.runId })));
  }
  return out.sort((a, b) => a.timestamp - b.timestamp);
}

// Topics with the highest clarification counts, descending.
export function getUserDifficultyTopics(store, participantId, lectureId = null) {
  const m = store.get(participantId);
  if (!m) return [];
  const counts = {};
  for (const lec of m.lectures.values()) {
    if (lectureId && lec.lectureId !== lectureId) continue;
    for (const [t, c] of Object.entries(lec.clarificationCountByTopic)) {
      counts[t] = (counts[t] || 0) + c;
    }
  }
  return Object.entries(counts).filter(([, c]) => c > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([topicId, count]) => ({ topicId, count }));
}

// Compact summary for one lecture across ALL runs of that lecture.
export function getUserLearningSummary(store, participantId, lectureId) {
  const m = store.get(participantId);
  if (!m) return null;
  const topicsSeen = new Set(), topicsMissed = new Set();
  const clarifications = {}, reexplained = new Set();
  const questions = [];
  let attended = false;
  for (const lec of m.lectures.values()) {
    if (lec.lectureId !== lectureId) continue;
    attended = true;
    lec.topicsSeen.forEach((t) => { topicsSeen.add(t); topicsMissed.delete(t); });
    lec.topicsMissed.forEach((t) => { if (!topicsSeen.has(t)) topicsMissed.add(t); });
    lec.reexplainedTopics.forEach((t) => reexplained.add(t));
    questions.push(...lec.questions);
    for (const [t, c] of Object.entries(lec.clarificationCountByTopic)) {
      clarifications[t] = (clarifications[t] || 0) + c;
    }
  }
  if (!attended) return null;
  questions.sort((a, b) => a.timestamp - b.timestamp);
  return {
    participantId,
    lectureId,
    topicsSeen: [...topicsSeen],
    topicsMissed: [...topicsMissed],
    questionCount: questions.length,
    groupRecapCount: [...m.lectures.values()]
      .filter((l) => l.lectureId === lectureId)
      .reduce((n, l) => n + (l.groupRecaps?.length || 0), 0),
    clarificationTopics: Object.keys(clarifications).filter((t) => clarifications[t] > 0),
    clarificationCountByTopic: clarifications,
    reexplainedTopics: [...reexplained],
    recentQuestions: questions.slice(-5),
  };
}

// ---- hydration --------------------------------------------------------------

// Load a user's persisted memory into RAM (cold start / new server process).
export async function hydrateUserMemory(store, participantId, loader) {
  const data = await loader(participantId); // queries.loadUser result shape
  const m = getOrCreate(store, participantId);
  for (const s of data.sessions) {
    const lec = getRun(m, s.lecture_id, s.run_id);
    lec.joinedAt = new Date(s.joined_at).getTime();
    lec.lastSeenAt = new Date(s.last_seen_at).getTime();
  }
  for (const t of data.topics) {
    const lec = getRun(m, t.lecture_id, t.run_id);
    if (t.seen && !lec.topicsSeen.includes(t.topic_id)) lec.topicsSeen.push(t.topic_id);
    if (t.missed && !lec.topicsSeen.includes(t.topic_id) && !lec.topicsMissed.includes(t.topic_id)) {
      lec.topicsMissed.push(t.topic_id);
    }
    if (t.clarification_count > 0) lec.clarificationCountByTopic[t.topic_id] = t.clarification_count;
    if (t.reexplained && !lec.reexplainedTopics.includes(t.topic_id)) lec.reexplainedTopics.push(t.topic_id);
  }
  for (const q of data.questions) {
    const lec = getRun(m, q.lecture_id, q.run_id);
    const ts = new Date(q.asked_at).getTime();
    // idempotent: match persisted row by content+timestamp, never re-add
    if (lec.questions.some((e) => e.question === q.question && e.timestamp === ts)) continue;
    lec.questions.push({ topicId: q.topic_id, segmentId: q.segment_id, question: q.question,
      answer: q.answer, timestamp: ts });
  }
  return m;
}

export function createUserMemoryStore() { return new Map(); }
