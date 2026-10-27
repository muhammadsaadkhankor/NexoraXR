// Unified room registry — holds classroom metadata for BOTH room types.
//
//   public  : discoverable via GET /api/rooms/public, joined directly by
//             roomId — no token required.
//   private : never listed; admission requires the cryptographically random
//             inviteToken. roomId = identity, inviteToken = authorization.
//
// inviteToken exists only here — it is never stored on NcipRoom and never
// appears in session snapshots or public listings.
import { randomBytes } from 'node:crypto';
import { SUPPORTED_LANGUAGES } from './ncipRoom.mjs';

const CLASS_NAME_MAX = 80;
const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/; // lectureId / courseId / scene

export class RoomRegistry {
  constructor() {
    this.rooms = new Map(); // roomId -> room record
  }

  // Returns { error } on invalid input, otherwise the room record.
  // Rehydrate persisted rooms on boot — private invite links survive restarts.
  async hydrate(pool) {
    try {
      const { rows } = await pool.query(
        `SELECT * FROM classrooms WHERE ended_at IS NULL`);
      for (const r of rows) {
        if (this.rooms.has(r.id)) continue;
        this.rooms.set(r.id, {
          roomId: r.id, roomType: r.room_type, className: r.class_name,
          courseId: r.course_id, courseName: r.course_name,
          lectureId: r.lecture_id, language: r.language, hostId: r.host_id,
          scene: r.scene, lectureCount: r.lecture_count,
          inviteToken: r.invite_token, createdAt: r.created_at,
        });
      }
      if (rows.length) console.log(`[rooms] rehydrated ${rows.length} classroom(s) from database`);
    } catch (err) {
      console.error('[rooms] hydrate failed:', err.message);
    }
  }

  _persist(pool, room) {
    if (!pool) return;
    pool.query(
      `INSERT INTO classrooms (id, host_id, class_name, course_id, course_name, room_type, scene, language, lecture_id, lecture_count, invite_token)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (id) DO UPDATE SET class_name=$3, invite_token=$11, ended_at=NULL`,
      [room.roomId, room.hostId, room.className,
       /^[0-9a-f-]{36}$/i.test(room.courseId || '') ? room.courseId : null,
       room.courseName,
       room.roomType, room.scene, room.language, room.lectureId, room.lectureCount, room.inviteToken])
      .catch((e) => console.error('[rooms] persist failed:', e.message));
  }

  setPool(pool) { this._pool = pool; }

  create({ roomType, className, courseId, courseName, lectureId, language, hostId, scene, lectureCount }) {
    if (roomType !== 'public' && roomType !== 'private') {
      return { error: "roomType must be 'public' or 'private'" };
    }
    if (typeof className !== 'string' || !className.trim() || className.length > CLASS_NAME_MAX) {
      return { error: 'A class name (1–80 characters) is required' };
    }
    // lectureId is optional — the room's lecture is picked on entry via the
    // course picker; a supplied id is still validated when present.
    if (lectureId != null && lectureId !== '' && !SAFE_ID_RE.test(lectureId)) {
      return { error: 'Invalid lectureId' };
    }
    if (courseId != null && !SAFE_ID_RE.test(courseId)) {
      return { error: 'Invalid courseId' };
    }
    if (language != null && !SUPPORTED_LANGUAGES.includes(language)) {
      return { error: `Unsupported language '${language}'` };
    }
    const roomId = `${roomType === 'private' ? 'priv' : 'pub'}_${randomBytes(9).toString('hex')}`;
    const room = {
      roomId,
      roomType,
      className: className.trim(),
      courseId: courseId || null,
      courseName: typeof courseName === 'string' && courseName.trim()
        ? courseName.trim().slice(0, 80) : null,
      // Planned course length — free-form instructor input, capped sanely.
      lectureCount: Number.isInteger(lectureCount) && lectureCount >= 1 && lectureCount <= 500
        ? lectureCount : null,
      lectureId: lectureId || null,
      language: language || 'en',
      scene: scene && SAFE_ID_RE.test(scene) ? scene : 'Multimedia',
      hostId: typeof hostId === 'string' && hostId.length <= 64 ? hostId : null,
      createdAt: Date.now(),
    };
    if (roomType === 'private') {
      room.inviteToken = randomBytes(24).toString('base64url'); // 192-bit
      // Reusable link: any holder may REQUEST entry; the host approves each.
    }
    this.rooms.set(roomId, room);
    this._persist(this._pool, room);
    return { room };
  }

  createPublic(fields) {
    return this.create({ ...fields, roomType: 'public' });
  }

  createPrivate(fields) {
    return this.create({ ...fields, roomType: 'private' });
  }

  get(roomId) {
    return this.rooms.get(roomId) || null;
  }

  isPrivate(roomId) {
    return this.rooms.get(roomId)?.roomType === 'private';
  }

  remove(roomId) {
    this.rooms.delete(roomId);
    this._pool?.query(`UPDATE classrooms SET ended_at=now() WHERE id=$1`, [roomId])
      .catch((e) => console.error('[rooms] remove persist failed:', e.message));
  }

  // Admission: public rooms admit any joiner who knows the roomId; private
  // rooms require the invite token. Same opaque error for missing/wrong.
  admit(roomId, inviteToken) {
    const room = this.rooms.get(roomId);
    if (!room) return { ok: false, error: 'This classroom link is invalid or has expired.' };
    if (room.roomType === 'private') return this.authorize(roomId, inviteToken);
    return { ok: true, room };
  }

  // Private invite check: the token must match the current invite. Links are
  // reusable — admission is decided by the host, not by token consumption.
  authorize(roomId, inviteToken) {
    const room = this.rooms.get(roomId);
    if (!room || room.roomType !== 'private') {
      return { ok: false, error: 'This classroom link is invalid or has expired.' };
    }
    if (typeof inviteToken !== 'string' || inviteToken !== room.inviteToken) {
      return { ok: false, error: 'Invalid or expired invite link.' };
    }
    return { ok: true, room };
  }

  // Flip visibility. Owner (or SUPER_ADMIN via isAdmin) only; server-side
  // authority — the registry object updates immediately so listPublic/admit
  // reflect the change with no restart. The inviteToken is preserved across
  // flips so a re-privatized room keeps its link.
  setVisibility(roomId, roomType, actorId, isAdmin = false) {
    const room = this.rooms.get(roomId);
    if (!room) return { ok: false, status: 404, error: 'Classroom not found' };
    if (roomType !== 'public' && roomType !== 'private') {
      return { ok: false, status: 400, error: "visibility must be 'public' or 'private'" };
    }
    if (!isAdmin && room.hostId !== actorId) {
      return { ok: false, status: 403, error: 'Only the classroom owner can change visibility' };
    }
    if (room.roomType === roomType) return { ok: true, room };
    room.roomType = roomType;
    if (roomType === 'private' && !room.inviteToken) {
      room.inviteToken = randomBytes(24).toString('base64url');
    }
    this._pool?.query(`UPDATE classrooms SET room_type=$2, invite_token=$3 WHERE id=$1`,
      [roomId, roomType, room.inviteToken || null])
      .catch((e) => console.error('[rooms] visibility persist failed:', e.message));
    return { ok: true, room };
  }

  // Mint a fresh invite link. Only the host may rotate; the previous link
  // stops working — the way a host revokes a link that spread too far.
  rotateInvite(roomId, hostId) {
    const room = this.rooms.get(roomId);
    if (!room || room.roomType !== 'private' || room.hostId !== hostId) {
      return { ok: false };
    }
    room.inviteToken = randomBytes(24).toString('base64url');
    this._pool?.query(`UPDATE classrooms SET invite_token=$2 WHERE id=$1`, [roomId, room.inviteToken])
      .catch(() => {});
    return { ok: true, room };
  }

  // Gallery listing — safe fields only, no inviteToken, no internals.
  listPublic() {
    return [...this.rooms.values()]
      .filter((r) => r.roomType === 'public')
      .map(({ roomId, roomType, className, courseId, courseName, lectureCount, lectureId, language, scene, hostId, createdAt }) =>
        ({ roomId, roomType, className, courseId, courseName, lectureCount, lectureId, language, scene, hostId, createdAt }));
  }
}
