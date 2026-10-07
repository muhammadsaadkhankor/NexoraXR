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
  create({ roomType, className, courseId, lectureId, language, hostId, scene }) {
    if (roomType !== 'public' && roomType !== 'private') {
      return { error: "roomType must be 'public' or 'private'" };
    }
    if (typeof className !== 'string' || !className.trim() || className.length > CLASS_NAME_MAX) {
      return { error: 'A class name (1–80 characters) is required' };
    }
    if (!SAFE_ID_RE.test(lectureId || '')) {
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
      lectureId,
      language: language || 'en',
      scene: scene && SAFE_ID_RE.test(scene) ? scene : 'Multimedia',
      hostId: typeof hostId === 'string' && hostId.length <= 64 ? hostId : null,
      createdAt: Date.now(),
    };
    if (roomType === 'private') {
      room.inviteToken = randomBytes(24).toString('base64url'); // 192-bit
      room.inviteUsed = false; // single-use: consumed when a guest requests entry
    }
    this.rooms.set(roomId, room);
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
  }

  // Admission: public rooms admit any joiner who knows the roomId; private
  // rooms require the invite token. Same opaque error for missing/wrong.
  admit(roomId, inviteToken) {
    const room = this.rooms.get(roomId);
    if (!room) return { ok: false, error: 'This classroom link is invalid or has expired.' };
    if (room.roomType === 'private') return this.authorize(roomId, inviteToken);
    return { ok: true, room };
  }

  // Private invite check: token must match AND be unused (single-use links).
  authorize(roomId, inviteToken) {
    const room = this.rooms.get(roomId);
    if (!room || room.roomType !== 'private') {
      return { ok: false, error: 'This classroom link is invalid or has expired.' };
    }
    if (typeof inviteToken !== 'string' || inviteToken !== room.inviteToken || room.inviteUsed) {
      return { ok: false, error: 'Invalid or expired invite link.' };
    }
    return { ok: true, room };
  }

  // Burn the current invite — called when a guest's request is handed to the
  // host for approval. A rejected guest cannot retry the same link.
  consumeInvite(roomId) {
    const room = this.rooms.get(roomId);
    if (room?.roomType === 'private') room.inviteUsed = true;
  }

  // Mint a fresh single-use invite. Only the host may rotate.
  rotateInvite(roomId, hostId) {
    const room = this.rooms.get(roomId);
    if (!room || room.roomType !== 'private' || room.hostId !== hostId) {
      return { ok: false };
    }
    room.inviteToken = randomBytes(24).toString('base64url');
    room.inviteUsed = false;
    return { ok: true, room };
  }

  // Gallery listing — safe fields only, no inviteToken, no internals.
  listPublic() {
    return [...this.rooms.values()]
      .filter((r) => r.roomType === 'public')
      .map(({ roomId, roomType, className, courseId, lectureId, language, scene, hostId, createdAt }) =>
        ({ roomId, roomType, className, courseId, lectureId, language, scene, hostId, createdAt }));
  }
}
