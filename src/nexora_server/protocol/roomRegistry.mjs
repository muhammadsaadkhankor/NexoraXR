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

  // Mint a fresh invite link. Only the host may rotate; the previous link
  // stops working — the way a host revokes a link that spread too far.
  rotateInvite(roomId, hostId) {
    const room = this.rooms.get(roomId);
    if (!room || room.roomType !== 'private' || room.hostId !== hostId) {
      return { ok: false };
    }
    room.inviteToken = randomBytes(24).toString('base64url');
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
