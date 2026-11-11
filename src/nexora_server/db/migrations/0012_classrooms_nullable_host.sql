-- Standalone lecture rooms (pub_lecture__<lectureId>) have no host by
-- design, but host_id was NOT NULL — their persist silently failed, so the
-- room lived only in memory and a server restart made refreshes hit
-- "Scene not found" (GET /api/rooms/:id -> 404).
ALTER TABLE classrooms ALTER COLUMN host_id DROP NOT NULL;
