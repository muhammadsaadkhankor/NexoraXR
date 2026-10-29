// Canonical classroom URLs: /classroom/<class-name-slug>?room=<id>&lecture=<id>
// The slug is cosmetic — derived from the classroom/course name so a "Haptics"
// class reads /classroom/haptics. The room registry (resolved via ?room=)
// remains authoritative for which 3D scene renders; bare /scene/<SceneKey>
// links still work for direct scene entry.

export const slugify = (s) => String(s || '')
  .toLowerCase()
  .trim()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '');

export const classroomSlug = (room) =>
  slugify(room?.className || room?.courseName) || room?.scene || 'classroom';

export const classroomPath = (room) => {
  const q = new URLSearchParams();
  if (room?.roomId) q.set('room', room.roomId);
  if (room?.lectureId) q.set('lecture', room.lectureId);
  const qs = q.toString();
  return `/classroom/${encodeURIComponent(classroomSlug(room))}${qs ? `?${qs}` : ''}`;
};
