-- Persisted classrooms. roomRegistry rehydrates from this table on boot so
-- private invite links keep working across server restarts.
CREATE TABLE IF NOT EXISTS classrooms (
  id            text PRIMARY KEY,               -- roomId (pub_/priv_)
  host_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  class_name    varchar(80) NOT NULL,
  course_id     uuid REFERENCES courses(id) ON DELETE SET NULL,
  course_name   varchar(80),
  room_type     varchar(8) NOT NULL,            -- public|private
  scene         varchar(64) NOT NULL DEFAULT 'Multimedia',
  language      varchar(8),
  lecture_id    varchar(64),
  lecture_count integer,
  invite_token  text,                           -- private only
  created_at    timestamptz NOT NULL DEFAULT now(),
  ended_at      timestamptz                     -- set when the room is closed
);
CREATE INDEX IF NOT EXISTS classrooms_host ON classrooms (host_id) WHERE ended_at IS NULL;
