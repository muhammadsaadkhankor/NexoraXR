-- Instructor-owned courses. A classroom (roomRegistry) references a course by
-- id; materials uploaded to a room belong to that room's course session.
CREATE TABLE IF NOT EXISTS courses (
  id          uuid PRIMARY KEY,
  owner_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        varchar(80) NOT NULL,
  scene       varchar(64) NOT NULL DEFAULT 'Multimedia',
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, name)
);
