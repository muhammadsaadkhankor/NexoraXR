-- 0001_user_memory — existing learning-memory schema, moved verbatim from
-- persistence/userMemoryDb.mjs SCHEMA. IF NOT EXISTS preserved so a database
-- already created by the old boot-time CREATEs is adopted without changes.

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
