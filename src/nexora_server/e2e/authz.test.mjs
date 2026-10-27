// E2E: Stage-2 authentication + event authorization on a real server with a
// real Postgres (TEST_DATABASE_URL / DATABASE_URL). Skips when no DB.
//
// Covers: magic-link request -> console link -> verify -> session cookie ->
// authenticated socket join; guest join + restricted-event rejection;
// guestToken reconnect; room creation gating.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(new URL('../../nexora_client/package.json', import.meta.url));
const { io: ioClient } = require('socket.io-client');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3995;
const BASE = `http://localhost:${PORT}`;
const BASE_DB = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

// E2E never pollutes the dev DB: given postgres://…:port/nexoraxr it creates
// and uses a dedicated `nexoraxr_e2e` database instead (created once, reused).
async function provisionE2EDB(url) {
  try {
    const u = new URL(url);
    const e2eName = `${u.pathname.slice(1)}_e2e`;
    u.pathname = '/postgres';
    const pg = await import('pg').then((m) => m.default || m);
    const p = new pg.Pool({ connectionString: u.toString() });
    const { rows } = await p.query(`SELECT 1 FROM pg_database WHERE datname=$1`, [e2eName]);
    if (!rows.length) await p.query(`CREATE DATABASE "${e2eName}"`);
    await p.end();
    const out = new URL(url);
    out.pathname = `/${e2eName}`;
    return out.toString();
  } catch (err) {
    console.warn('[e2e] could not provision e2e database, falling back:', err.message);
    return url;
  }
}

const maybe = BASE_DB ? test : test.skip;
let server;
let DB;
let stdoutBuf = '';

before(async () => {
  if (!BASE_DB) return;
  DB = await provisionE2EDB(BASE_DB);
  server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env, PORT: String(PORT),
      DATABASE_URL: DB, // e2e-isolated database (dev stays untouched)
      AUTH_DELIVERY_MODE: 'console',
      PUBLIC_BASE_URL: BASE,
      NXR_ADMIN_CLAIM_TOKEN: 'e2e-admin-claim-secret',
      NXR_DEV_UNAUTH_PROTOCOL: '', // enforcement ON — this is what we're testing
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  server.stdout.on('data', (d) => { stdoutBuf += d.toString(); });
  for (let i = 0; i < 80; i++) {
    try { await fetch(`${BASE}/api/rooms/public`); return; }
    catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  throw new Error('server did not start');
});

after(() => { server?.kill('SIGKILL'); });

const connect = (cookie) => new Promise((res, rej) => {
  const s = ioClient(BASE, {
    transports: ['websocket'], reconnection: false,
    extraHeaders: cookie ? { Cookie: cookie } : {},
  });
  s.on('connect', () => res(s));
  s.on('connect_error', rej);
});

const waitFor = (s, event, pred = () => true, ms = 6000) =>
  new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`timeout waiting for '${event}'`)), ms);
    const h = (d) => { if (pred(d)) { clearTimeout(t); s.off(event, h); res(d); } };
    s.on(event, h);
  });

async function loginUser(email) {
  // Track where the buffer ends before requesting — each link request prints
  // a new line, so only search output written after this point.
  const mark = stdoutBuf.length;
  const r = await fetch(`${BASE}/auth/request-link`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  assert.equal(r.status, 200);
  // Wait briefly for the console print, then search only the NEW output.
  await new Promise((res) => setTimeout(res, 300));
  const m = new RegExp(`${BASE.replace(/[./:]/g, '\\$&')}/auth/verify\\?token=[A-Za-z0-9_\\-]+`).exec(stdoutBuf.slice(mark));
  assert.ok(m, 'magic link not found in server console output');
  const token = m[0].split('token=')[1];
  // GET does not consume:
  const g = await fetch(`${BASE}/auth/verify?token=${token}`);
  assert.equal(g.status, 200);
  const v = await fetch(`${BASE}/auth/verify`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  assert.equal(v.status, 200);
  const cookie = (v.headers.get('set-cookie') || '').split(';')[0];
  assert.ok(cookie.startsWith('nxr_session='));
  const body = await v.json();
  return { cookie, user: body.user };
}

maybe('student magic-link login, socket identity, and event gates', async () => {
  const email = `e2e-${Date.now()}@example.com`;
  const { cookie, user } = await loginUser(email);
  assert.equal(user.role, 'STUDENT');

  // /auth/me sees the session
  const me = await fetch(`${BASE}/auth/me`, { headers: { Cookie: cookie } });
  assert.equal((await me.json()).user.email, email);

  // Authenticated socket: pid = users.id
  const s = await connect(cookie);
  s.emit('join', { roomId: 'e2e-auth-room', name: 'Student' });
  const info = await waitFor(s, 'self-info');
  assert.equal(info.guest, false);
  assert.equal(info.participantId, user.id);
  // Authenticated student MAY request the floor (even if the state machine
  // has nothing for it — the gate is auth, not the outcome).
  s.emit('request-floor');
  const floor = await waitFor(s, 'floor-state');
  assert.equal(floor.activeSpeaker?.userId, user.id);

  // Students cannot create classrooms.
  const rc = await fetch(`${BASE}/api/rooms`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ className: 'Nope', roomType: 'public' }),
  });
  assert.equal(rc.status, 403);

  // Logout revokes the session.
  await fetch(`${BASE}/auth/logout`, { method: 'POST', headers: { Cookie: cookie } });
  const me2 = await fetch(`${BASE}/auth/me`, { headers: { Cookie: cookie } });
  assert.equal((await me2.json()).user, null);
  s.disconnect();
});

maybe('guest join, guest-token reconnect, and restricted-event rejection', async () => {
  const g = await connect();
  // Both arrive during join — attach listeners BEFORE emitting.
  const credsP = waitFor(g, 'guest-session');
  const infoP = waitFor(g, 'self-info');
  g.emit('join', { roomId: 'e2e-guest-room', name: 'Guest' });
  const info = await infoP;
  assert.equal(info.guest, true);
  assert.ok(info.participantId.startsWith('gst_'));
  const creds = await credsP;
  assert.ok(creds.guestToken.length > 20);

  // Restricted events are rejected.
  g.emit('request-floor');
  const e1 = await waitFor(g, 'auth-error');
  assert.equal(e1.event, 'request-floor');
  g.emit('ask-floor-question', { question: 'hello?' });
  const e2 = await waitFor(g, 'auth-error');
  assert.equal(e2.event, 'ask-floor-question');
  g.emit('lecture.start', { lectureId: 'Lecture_1' });
  const e3 = await waitFor(g, 'auth-error');
  assert.equal(e3.event, 'lecture.start');
  g.emit('mic.decision', { userId: 'someone', grant: true });
  const e4 = await waitFor(g, 'auth-error');
  assert.equal(e4.event, 'mic.decision');

  // Guests CAN request a microphone (pending state).
  g.emit('mic.request');
  const mic = await waitFor(g, 'mic-state', (d) => d.permissions?.[info.participantId] === 'pending');
  assert.ok(mic);

  // Reconnect with the guest token reclaims the same pid — and a forged
  // participantId cannot steal it.
  g.disconnect();
  const g2 = await connect();
  g2.emit('join', {
    roomId: 'e2e-guest-room', name: 'Guest',
    guestToken: creds.guestToken,
    participantId: 'forged-pid-attempt', // must be ignored
  });
  const info2 = await waitFor(g2, 'self-info');
  assert.equal(info2.participantId, info.participantId);
  g2.disconnect();
});

maybe('admin claim, user listing, and access revocation', async () => {
  const admin = await loginUser(`e2e-admin-${Date.now()}@example.com`);
  const victim = await loginUser(`e2e-victim-${Date.now()}@example.com`);

  // STUDENT cannot hit admin endpoints.
  const denied = await fetch(`${BASE}/api/admin/users`, { headers: { Cookie: admin.cookie } });
  assert.equal(denied.status, 403);

  // Wrong claim token rejected; correct one elevates.
  const bad = await fetch(`${BASE}/auth/claim-admin`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
    body: JSON.stringify({ token: 'wrong' }),
  });
  assert.equal(bad.status, 403);
  const claim = await fetch(`${BASE}/auth/claim-admin`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
    body: JSON.stringify({ token: 'e2e-admin-claim-secret' }),
  });
  assert.equal(claim.status, 200);
  assert.equal((await claim.json()).role, 'SUPER_ADMIN');

  // Admin sees all users including the victim.
  const list = await fetch(`${BASE}/api/admin/users`, { headers: { Cookie: admin.cookie } });
  assert.equal(list.status, 200);
  const users = (await list.json()).users;
  const target = users.find((u) => u.id === victim.user.id);
  assert.ok(target && target.is_active);
  assert.equal(target.role, 'STUDENT');

  // Victim session works before revocation…
  const before = await fetch(`${BASE}/auth/me`, { headers: { Cookie: victim.cookie } });
  assert.ok((await before.json()).user);

  // …admin revokes access → session dies immediately.
  const patch = await fetch(`${BASE}/api/admin/users/${victim.user.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
    body: JSON.stringify({ isActive: false }),
  });
  assert.equal(patch.status, 200);
  const after = await fetch(`${BASE}/auth/me`, { headers: { Cookie: victim.cookie } });
  assert.equal((await after.json()).user, null);

  // Hard delete removes the row (sessions cascade-delete with it).
  const del = await fetch(`${BASE}/api/admin/users/${victim.user.id}`, {
    method: 'DELETE', headers: { Cookie: admin.cookie },
  });
  assert.equal(del.status, 200);
  const list2 = await (await fetch(`${BASE}/api/admin/users`, { headers: { Cookie: admin.cookie } })).json();
  assert.ok(!list2.users.some((u) => u.id === victim.user.id));
  // Self-delete is refused.
  const selfDel = await fetch(`${BASE}/api/admin/users/${admin.user.id}`, {
    method: 'DELETE', headers: { Cookie: admin.cookie },
  });
  assert.equal(selfDel.status, 400);

  // Admin cannot demote/deactivate self.
  const self = await fetch(`${BASE}/api/admin/users/${admin.user.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
    body: JSON.stringify({ isActive: false }),
  });
  assert.equal(self.status, 400);
});

maybe('instructor can create public and private classrooms', async () => {
  const inst = await loginUser(`e2e-instructor-${Date.now()}@example.com`);
  // INSTRUCTOR has no claim endpoint — promote via SQL (operator path).
  const pg = await import('pg').then((m) => m.default || m);
  const p = new pg.Pool({ connectionString: DB });
  await p.query(`UPDATE users SET role='INSTRUCTOR' WHERE id=$1`, [inst.user.id]);
  await p.end();

  for (const roomType of ['public', 'private']) {
    const r = await fetch(`${BASE}/api/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: inst.cookie },
      body: JSON.stringify({ className: `E2E ${roomType}`, roomType, courseId: 'Multimedia', hostId: 'forged' }),
    });
    assert.equal(r.status, 201, roomType);
    const room = await r.json();
    // hostId is the authenticated user — never the forged body value.
    assert.equal(room.hostId, inst.user.id);
    assert.equal(room.roomType, roomType);
    if (roomType === 'private') assert.ok(room.inviteUrl);
  }
});

maybe('password registration then email+password login', async () => {
  const email = `e2e-pw-${Date.now()}@example.com`;
  const mark = stdoutBuf.length;
  await fetch(`${BASE}/auth/request-link`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, firstName: 'Pw', lastName: 'User', password: 'correct horse battery' }),
  });
  await new Promise((r) => setTimeout(r, 300));
  const m = new RegExp(`${BASE.replace(/[./:]/g, '\\$&')}/auth/verify\\?token=[A-Za-z0-9_\\-]+`).exec(stdoutBuf.slice(mark));
  const token = m[0].split('token=')[1];
  await fetch(`${BASE}/auth/verify`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });

  // Name came from the registration link; password login works.
  const bad = await fetch(`${BASE}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'wrong' }),
  });
  assert.equal(bad.status, 401);
  const good = await fetch(`${BASE}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'correct horse battery' }),
  });
  assert.equal(good.status, 200);
  const { user } = await good.json();
  assert.equal(user.displayName, 'Pw User');
  assert.equal(user.role, 'STUDENT');

  // Re-requesting a link for a passworded account is refused.
  const again = await fetch(`${BASE}/auth/request-link`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'long-enough-password' }),
  });
  assert.equal(again.status, 409);
});

maybe('unauthenticated HTTP restrictions', async () => {
  const r1 = await fetch(`${BASE}/api/rooms`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ className: 'Nope', roomType: 'public', hostId: 'forged' }),
  });
  assert.equal(r1.status, 401);
  const r2 = await fetch(`${BASE}/settings`);
  assert.equal(r2.status, 401);
  const r3 = await fetch(`${BASE}/api/learning/user_memory/anyone/Lecture_1`);
  assert.equal(r3.status, 401);
});
