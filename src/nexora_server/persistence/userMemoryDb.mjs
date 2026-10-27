// User learning-memory persistence — query layer over the shared pool.
//
// Hot path contract: ALL writes go through `persist(task)` — queued
// fire-and-forget. Nothing in the lecture loop ever awaits a DB write.
// If Postgres is unavailable the module degrades to `noop` (logged once);
// RAM memory keeps working, persistence is just skipped.
//
// Schema lives in db/migrations/0001_user_memory.sql — applied by the
// versioned migration runner (db/migrate.mjs), not here.
//
// Backend selection (delegated to db/pool.mjs):
//   DATABASE_URL set -> real pg Pool
//   test/injected    -> any Pool-compatible object (e.g. pg-mem)
//   neither          -> noop (degraded mode)
//
// Run identity: every lecture start gets a run_id (uuid) so Lecture_1 Run A
// and Run B never overwrite each other.

import { initDb, getPool, dbAvailable, persist } from '../db/pool.mjs';

export { dbAvailable, persist };

// Kept for API compatibility — now just delegates to the shared pool init.
// Adapter callers get migrations applied (0001 creates these tables).
export async function initUserMemoryDb(adapter = null) {
  const pool = await initDb(adapter);
  if (!pool && !adapter && !process.env.DATABASE_URL) {
    // degraded mode — silent noop, same contract as before
  }
  return pool;
}

export const queries = {
  upsertSession: (p, { participantId, lectureId, runId, lastSeenAt }) =>
    p.query(
      `INSERT INTO user_lecture_sessions (participant_id, lecture_id, run_id, last_seen_at)
       VALUES ($1,$2,$3, COALESCE($4, now()))
       ON CONFLICT (participant_id, run_id)
       DO UPDATE SET last_seen_at = COALESCE($4, now())`,
      [participantId, lectureId, runId, lastSeenAt ? new Date(lastSeenAt) : null]
    ),

  upsertTopic: (p, { participantId, runId, lectureId, topicId, seen, missed, clarificationCount, reexplained }) =>
    p.query(
      `INSERT INTO user_topic_memory
         (participant_id, run_id, lecture_id, topic_id, seen, missed, clarification_count, reexplained)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (participant_id, run_id, topic_id)
       DO UPDATE SET
         seen = user_topic_memory.seen OR EXCLUDED.seen,
         missed = user_topic_memory.missed OR EXCLUDED.missed,
         clarification_count = GREATEST(user_topic_memory.clarification_count, EXCLUDED.clarification_count),
         reexplained = user_topic_memory.reexplained OR EXCLUDED.reexplained,
         updated_at = now()`,
      [participantId, runId, lectureId, topicId, !!seen, !!missed, clarificationCount || 0, !!reexplained]
    ),

  insertQuestion: (p, { participantId, runId, lectureId, topicId, segmentId, question, answer, timestamp }) =>
    p.query(
      `INSERT INTO user_question_memory
         (participant_id, run_id, lecture_id, topic_id, segment_id, question, answer, asked_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7, COALESCE($8, now()))`,
      [participantId, runId, lectureId, topicId ?? null, segmentId ?? null, question, answer,
       timestamp ? new Date(timestamp) : null]
    ),

  loadUser: async (p, participantId) => {
    const [sessions, topics, questions] = await Promise.all([
      p.query(`SELECT * FROM user_lecture_sessions WHERE participant_id = $1`, [participantId]),
      p.query(`SELECT * FROM user_topic_memory WHERE participant_id = $1`, [participantId]),
      p.query(`SELECT * FROM user_question_memory WHERE participant_id = $1 ORDER BY asked_at, id`, [participantId]),
    ]);
    return { sessions: sessions.rows, topics: topics.rows, questions: questions.rows };
  },
};

// Internal helper retained for callers that need the raw pool (e.g. tests).
export function userMemoryPool() { return getPool(); }
