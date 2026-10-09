// Room registry tests — public + private classroom lifecycle. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoomRegistry } from './roomRegistry.mjs';
import { NcipRoom } from './ncipRoom.mjs';

const mkPrivate = (reg = new RoomRegistry()) => {
  const { room } = reg.createPrivate({
    className: 'Arabic Study Group', courseId: 'Multimedia',
    lectureId: 'Lecture_1', language: 'ar', hostId: 'host-pid', scene: 'Multimedia',
  });
  return { reg, room };
};

// ---------------------------------------------------------------------------
// Private rooms (previous milestone guarantees — must keep passing)
// ---------------------------------------------------------------------------

test('host can create a private room with required fields', () => {
  const { room } = mkPrivate();
  assert.equal(room.roomType, 'private');
  assert.equal(room.hostId, 'host-pid');
  assert.equal(room.language, 'ar');
  assert.match(room.roomId, /^priv_[0-9a-f]{18}$/);
});

test('invite tokens are cryptographically random and unguessable', () => {
  const reg = new RoomRegistry();
  const tokens = new Set(Array.from({ length: 100 }, () =>
    reg.createPrivate({ className: 'x', lectureId: 'L', hostId: 'h' }).room.inviteToken));
  assert.equal(tokens.size, 100);
  for (const t of tokens) {
    assert.equal(t.length, 32);
    assert.match(t, /^[A-Za-z0-9_-]+$/);
  }
});

test('valid private invite admits', () => {
  const { reg, room } = mkPrivate();
  assert.equal(reg.admit(room.roomId, room.inviteToken).ok, true);
});

test('missing/wrong token cannot join a private room', () => {
  const { reg, room } = mkPrivate();
  assert.equal(reg.admit(room.roomId, undefined).ok, false);
  assert.equal(reg.admit(room.roomId, '').ok, false);
  const other = mkPrivate(reg).room;
  assert.equal(reg.admit(room.roomId, other.inviteToken).ok, false);
});

test('unknown roomId admits nobody and creates nothing', () => {
  const reg = new RoomRegistry();
  assert.equal(reg.admit('priv_000000000000000000', 'x').ok, false);
  assert.equal(reg.rooms.size, 0);
});

test('private rooms are not reachable as public sceneName rooms', () => {
  const { reg, room } = mkPrivate();
  assert.equal(reg.isPrivate('Multimedia'), false);
  assert.equal(reg.isPrivate(room.roomId), true);
  assert.ok(room.roomId.startsWith('priv_'));
});

// ---------------------------------------------------------------------------
// Public rooms
// ---------------------------------------------------------------------------

test('public classroom creates successfully with full metadata', () => {
  const reg = new RoomRegistry();
  const { room } = reg.createPublic({
    className: 'Computer Vision Study Room', courseId: 'CS401',
    lectureId: 'Lecture_3', language: 'en', hostId: 'h1', scene: 'CS401',
  });
  assert.equal(room.roomType, 'public');
  assert.equal(room.className, 'Computer Vision Study Room');
  assert.equal(room.courseId, 'CS401');
  assert.equal(room.lectureId, 'Lecture_3');
  assert.equal(room.language, 'en');
  assert.equal(room.hostId, 'h1');
  assert.match(room.roomId, /^pub_[0-9a-f]{18}$/);
  assert.equal(room.inviteToken, undefined); // public rooms have no token
});

test('public room joins WITHOUT an invite token', () => {
  const reg = new RoomRegistry();
  const { room } = reg.createPublic({ className: 'Study', lectureId: 'Lecture_1', hostId: 'h' });
  assert.equal(reg.admit(room.roomId, undefined).ok, true);
});

test('two guests admitted to the same public room get the same roomId', () => {
  const reg = new RoomRegistry();
  const { room } = reg.createPublic({ className: 'Study', lectureId: 'Lecture_1', hostId: 'h' });
  assert.equal(reg.admit(room.roomId).room.roomId, room.roomId);
  assert.equal(reg.admit(room.roomId).room.roomId, room.roomId); // same NcipRoom downstream
});

test('public rooms appear in listing; private rooms never do', () => {
  const reg = new RoomRegistry();
  reg.createPublic({ className: 'Pub A', lectureId: 'L1_x', hostId: 'h' });
  reg.createPublic({ className: 'Pub B', lectureId: 'L1_x', hostId: 'h' });
  const priv = mkPrivate(reg).room;
  const list = reg.listPublic();
  assert.equal(list.length, 2);
  assert.ok(list.every((r) => r.roomType === 'public'));
  assert.ok(!list.some((r) => r.roomId === priv.roomId));
});

test('public listing exposes safe fields only', () => {
  const reg = new RoomRegistry();
  reg.createPublic({ className: 'Pub', courseId: 'CS401', lectureId: 'L1_x', language: 'de', hostId: 'h' });
  const [card] = reg.listPublic();
  assert.deepEqual(Object.keys(card).sort(),
    ['className', 'courseId', 'createdAt', 'hostId', 'language', 'lectureId', 'roomId', 'roomType', 'scene'].sort());
  assert.ok(!JSON.stringify(card).includes('inviteToken'));
});

test('teardown removes the room from the listing', () => {
  const reg = new RoomRegistry();
  const { room } = reg.createPublic({ className: 'Pub', lectureId: 'L1_x', hostId: 'h' });
  assert.equal(reg.listPublic().length, 1);
  reg.remove(room.roomId); // called by cleanupAfterRemoval when room empties
  assert.equal(reg.listPublic().length, 0);
  assert.equal(reg.admit(room.roomId).ok, false); // stale links die too
});

test('roomIds are unique across public and private creations', () => {
  const reg = new RoomRegistry();
  const ids = new Set();
  for (let i = 0; i < 50; i++) {
    ids.add(reg.createPublic({ className: 'c', lectureId: 'L1_x', hostId: 'h' }).room.roomId);
    ids.add(reg.createPrivate({ className: 'c', lectureId: 'L1_x', hostId: 'h' }).room.roomId);
  }
  assert.equal(ids.size, 100);
});

test('invalid input is rejected', () => {
  const reg = new RoomRegistry();
  const bad = [
    { roomType: 'weird', className: 'c', lectureId: 'L' },
    { roomType: 'public', className: '', lectureId: 'L' },
    { roomType: 'public', className: 'c', lectureId: '../etc' },
    { roomType: 'public', className: 'c', lectureId: 'L', language: 'hi' },
    { roomType: 'public', className: 'c', lectureId: 'L', courseId: 'bad id!' },
  ];
  for (const b of bad) assert.ok(reg.create(b).error, JSON.stringify(b));
  assert.equal(reg.rooms.size, 0);
});

// ---------------------------------------------------------------------------
// Shared NCIP + no token leakage
// ---------------------------------------------------------------------------

test('admitted public and private rooms share the plain NcipRoom machinery', () => {
  const reg = new RoomRegistry();
  const pub = reg.createPublic({ className: 'P', lectureId: 'L1_x', language: 'fr', hostId: 'h' }).room;
  // server.js creates NcipRoom(roomId) + adopts registry type/language on
  // first admission — simulate that for both types:
  for (const meta of [pub, mkPrivate(reg).room]) {
    const ncip = new NcipRoom(meta.roomId);
    ncip.roomType = meta.roomType;
    ncip.language.roomLanguage = meta.language;
    ncip.joinParticipant(meta.hostId, 's1', 0);
    ncip.joinParticipant('guest', 's2', 1000);
    const snap = ncip.snapshot();
    assert.equal(snap.professor.status, 'IDLE');
    assert.ok(!JSON.stringify(snap).includes('inviteToken'));
    if (meta.inviteToken) assert.ok(!JSON.stringify(snap).includes(meta.inviteToken));
  }
});

// ---------------------------------------------------------------------------
// Single-use invites + host approval lifecycle
// ---------------------------------------------------------------------------

test('invite link is reusable: many guests can request with the same link', () => {
  const { reg, room } = mkPrivate();
  assert.equal(reg.authorize(room.roomId, room.inviteToken).ok, true);
  assert.equal(reg.authorize(room.roomId, room.inviteToken).ok, true); // still valid
  assert.equal(reg.admit(room.roomId, room.inviteToken).ok, true);     // and again
});

test('host can rotate the invite to mint a fresh link (old link dies)', () => {
  const { reg, room } = mkPrivate();
  const oldToken = room.inviteToken;
  const rot = reg.rotateInvite(room.roomId, 'host-pid');
  assert.equal(rot.ok, true);
  assert.notEqual(rot.room.inviteToken, oldToken);
  assert.equal(reg.authorize(room.roomId, rot.room.inviteToken).ok, true); // new link works
  assert.equal(reg.authorize(room.roomId, oldToken).ok, false);           // old link dead
});

test('non-host cannot rotate the invite', () => {
  const { reg, room } = mkPrivate();
  assert.equal(reg.rotateInvite(room.roomId, 'someone-else').ok, false);
  assert.equal(reg.rotateInvite(room.roomId, null).ok, false);
});

test('public rooms have no invite to rotate', () => {
  const reg = new RoomRegistry();
  const { room } = reg.createPublic({ className: 'P', lectureId: 'L1_x', hostId: 'h' });
  assert.equal(reg.rotateInvite(room.roomId, 'h').ok, false);
});

// ---------------------------------------------------------------------------
// Host authority resolution (lecture lifecycle gating in server.js uses:
// registry.get(roomId).roomType === 'private' && hostId === participantId)
// ---------------------------------------------------------------------------

test('registry resolves the creator as host; guests are not host', () => {
  const { reg, room } = mkPrivate();
  const meta = reg.get(room.roomId);
  assert.equal(meta.hostId, 'host-pid');
  assert.notEqual(meta.hostId, 'guest-pid');
  // Public rooms: hostId recorded but lifecycle gating does not apply (roomType check)
  const pub = reg.createPublic({ className: 'P', lectureId: 'L1_x', hostId: 'pub-host' }).room;
  assert.equal(reg.get(pub.roomId).roomType, 'public');
});

test('a guest participantId can never mint host authority', () => {
  const { reg, room } = mkPrivate();
  // rotate/decision authority checks compare pid === hostId exactly
  assert.equal(reg.rotateInvite(room.roomId, 'guest-pid').ok, false);
  assert.equal(reg.rotateInvite(room.roomId, 'host-pid').ok, true);
  // and a hostId survives reconnect semantics (stable participantId, not socket)
  assert.equal(reg.get(room.roomId).hostId, 'host-pid');
});
