-- Course-builder (Agentic RAG) storage.
-- course_documents: uploaded source PDFs + ingestion status.
-- course_chunks:   parsed text chunks + OpenAI embeddings (float8[] — no
--                  pgvector needed; cosine similarity computed in JS).
-- course_plans:    generated N-lecture outline (planning step result).
-- course_lectures: generated lecture manifests (lectureId → profbrain files).

CREATE TABLE IF NOT EXISTS course_documents (
  id          uuid PRIMARY KEY,
  course_id   uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  room_id     text,
  filename    varchar(160) NOT NULL,
  bytes       integer NOT NULL DEFAULT 0,
  sha256      text NOT NULL,
  status      text NOT NULL DEFAULT 'pending',  -- pending|processing|ready|failed
  error       text,
  uploaded_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS course_documents_course ON course_documents (course_id);

CREATE TABLE IF NOT EXISTS course_chunks (
  id          uuid PRIMARY KEY,
  document_id uuid NOT NULL REFERENCES course_documents(id) ON DELETE CASCADE,
  course_id   uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  idx         integer NOT NULL,
  heading     text,
  page        integer,
  text        text NOT NULL,
  embedding   double precision[]
);
CREATE INDEX IF NOT EXISTS course_chunks_course ON course_chunks (course_id);

CREATE TABLE IF NOT EXISTS course_plans (
  course_id   uuid PRIMARY KEY REFERENCES courses(id) ON DELETE CASCADE,
  outline     jsonb NOT NULL,   -- [{idx,title,objectives[],topicQueries[]}]
  lecture_count integer NOT NULL,
  status      text NOT NULL DEFAULT 'ready',  -- ready|failed
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS course_lectures (
  id          uuid PRIMARY KEY,
  course_id   uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  idx         integer NOT NULL,
  lecture_id  varchar(64) NOT NULL UNIQUE,   -- 'gen_<course>_L<idx>'
  title       varchar(200) NOT NULL,
  status      text NOT NULL DEFAULT 'ready',
  manifest    jsonb NOT NULL,                -- {lectureId,title,topics[]}
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (course_id, idx)
);
