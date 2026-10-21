// User learning-memory persistence — minimal PostgreSQL layer.
//
// Hot path contract: ALL writes go through `persist(task)` — queued
// fire-and-forget. Nothing in the lecture loop ever awaits a DB write.
// If Postgres is unavailable the module degrades to `noop` (logged once);
// RAM memory keeps working, persistence is just skipped.
//
// Backend selection:
//   DATABASE_URL set -> real pg Pool
//   test/injected    -> any Pool-compatible object (e.g. pg-mem)
//   neither          -> noop (degraded mode)
//
// Run identity: every lecture start gets a run_id (uuid) so Lecture_1 Run A
// and Run B never overwrite each other.

import { randomUUID } from 'node:crypto';

let pool = null;
let degraded = false;

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS user_lecture_sessions (
  participant_id TEXT NOT NULL,
  lecture_id     TEXT NOT NULL,
  run_id         TEXT NOT NULL,
  joined_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (participant_id, run_id)
);
CREATE TABLE IF NOT EXISTS user_topic_memory (
  participant_id      TEXT NOT NULL,
  run_id              TEXT NOT NULL,
  lecture_id          TEXT NOT NULL,
  topic_id            TEXT NOT NULL,
  seen                BOOLEAN NOT NULL DEFAULT false,
  missed              BOOLEAN NOT NULL DEFAULT false,
  clarification_count INT  NOT NULL DEFAULT 0,
  reexplained         BOOLEAN NOT NULL DEFAULT false,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (participant_id, run_id, topic_id)
);
CREATE INDEX IF NOT EXISTS user_topic_memory_pid_lecture
  ON user_topic_memory (participant_id, lecture_id);
CREATE TABLE IF NOT EXISTS user_question_memory (
  id             BIGSERIAL PRIMARY KEY,
  participant_id TEXT NOT NULL,
  run_id         TEXT NOT NULL,
  lecture_id     TEXT NOT NULL,
  topic_id       TEXT,
  segment_id     INT,
  question       TEXT NOT NULL,
  answer         TEXT NOT NULL,
  asked_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS user_question_memory_pid_lecture
  ON user_question_memory (participant_id, lecture_id);
`;

// Pass a Pool-compatible adapter in tests (pg-mem), or rely on DATABASE_URL.
export async function initUserMemoryDb(adapter = null) {
  if (adapter) { pool = adapter; await pool.query(SCHEMA); return pool; }
  if (!process.env.DATABASE_URL) { degraded = true; return null; }
  try {
    const { Pool } = await import('pg');
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await pool.query(SCHEMA);
    degraded = false;
    return pool;
  } catch (err) {
    degraded = true;
    console.error('[userMemoryDb] Postgres unavailable — memory is RAM-only:', err.message);
    pool = null;
    return null;
  }
}

export function dbAvailable() { return !!pool; }

// Queued fire-and-forget write. Never throws, never awaited by callers.
export function persist(task) {
  if (!pool) return;
  Promise.resolve()
    .then(() => task(pool))
    .catch((err) => console.error('[userMemoryDb] write failed (non-fatal):', err.message));
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
