-- PDF metadata title for lecture naming (plan-preview falls back to
-- headings/filename when missing).
ALTER TABLE course_documents
  ADD COLUMN IF NOT EXISTS title text;
