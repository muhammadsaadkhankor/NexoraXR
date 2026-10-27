-- Hierarchical course understanding + durable build state machine.

ALTER TABLE course_documents
  ADD COLUMN IF NOT EXISTS pages integer,
  ADD COLUMN IF NOT EXISTS summary text,
  ADD COLUMN IF NOT EXISTS concepts jsonb;  -- [{name, description, pages[]}]

ALTER TABLE course_chunks
  ADD COLUMN IF NOT EXISTS section_id uuid,
  ADD COLUMN IF NOT EXISTS page integer;    -- (may already exist; IF NOT EXISTS guards)

-- Section-level hierarchy between documents and chunks.
CREATE TABLE IF NOT EXISTS course_sections (
  id          uuid PRIMARY KEY,
  document_id uuid NOT NULL REFERENCES course_documents(id) ON DELETE CASCADE,
  course_id   uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  idx         integer NOT NULL,
  title       text,
  summary     text,
  page_start  integer,
  page_end    integer,
  embedding   double precision[]
);
CREATE INDEX IF NOT EXISTS course_sections_course ON course_sections (course_id);

-- Durable build jobs — the state machine that survives restarts.
-- status: pending|ingesting|planning|scripts|slides|audio|validating|ready|failed
CREATE TABLE IF NOT EXISTS course_builds (
  id            uuid PRIMARY KEY,
  course_id     uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  status        text NOT NULL DEFAULT 'pending',
  lecture_count integer NOT NULL,
  lang          varchar(8) NOT NULL DEFAULT 'en',
  error         text,
  stats         jsonb,          -- {lectures:[{idx,duration_s,segments}], started, finished}
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS course_builds_course ON course_builds (course_id, created_at DESC);

-- Per-lecture artifact completion — enables resume without re-work.
ALTER TABLE course_lectures
  ADD COLUMN IF NOT EXISTS artifacts jsonb,    -- {script:1, slides:1, audio:1, duration_s:…}
  ADD COLUMN IF NOT EXISTS build_id uuid;
