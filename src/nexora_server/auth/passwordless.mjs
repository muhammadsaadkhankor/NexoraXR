// Passwordless auth primitives — token generation, hashing, and the
// single-use verify transaction. No Express/Socket.IO imports here so the
// module is fully unit-testable against pg-mem.

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { withTransaction, getPool } from '../db/pool.mjs';

export const MAGIC_LINK_TTL_MS = 10 * 60 * 1000;      // 10 minutes
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const GUEST_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,24}$/;

export function normalizeEmail(raw) {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  return email.length <= 320 && EMAIL_RE.test(email) ? email : null;
}

export const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
export const newToken = () => randomBytes(32).toString('base64url'); // 256-bit
export const newGuestPid = () => `gst_${randomUUID()}`;

// Roles that may only be granted server-side (admin workflows or the
// dev bootstrap env lists) — never from a registration request.
const BOOTSTRAP_ROLES = { SUPER_ADMIN: 'NXR_ADMIN_EMAILS', INSTRUCTOR: 'NXR_INSTRUCTOR_EMAILS' };

// Dev bootstrap: accounts whose email appears in these env lists receive the
// elevated role AT CREATION. Role changes afterwards are admin-only (later
// stage). Not a public-registration path.
function bootstrapRole(email) {
  for (const [role, env] of Object.entries(BOOTSTRAP_ROLES)) {
    const list = (process.env[env] || '').split(',').map((e) => e.trim().toLowerCase());
    if (list.includes(email)) return role;
  }
  return 'STUDENT';
}

// ---- magic link lifecycle ---------------------------------------------------

const cleanName = (s) => (typeof s === 'string' ? s.trim().slice(0, 40) : '') || null;

// ---- passwords (argon2id) ---------------------------------------------------

let _argon2 = null;
async function argon2() {
  if (!_argon2) _argon2 = (await import('argon2')).default;
  return _argon2;
}
export async function hashPassword(pw) {
  const a = await argon2();
  return a.hash(pw, { type: a.argon2id });
}
export async function verifyPasswordHash(hash, pw) {
  const a = await argon2();
  return a.verify(hash, pw).catch(() => false);
}

// firstName/lastName/passwordHash ride along on the link row so account
// creation can set a real display_name and password at verify time.
export async function createMagicLink(email, names = {}) {
  const token = newToken();
  // expires_at computed in code — interval arithmetic parameters are not
  // portable to the pg-mem test adapter.
  await getPool().query(
    `INSERT INTO magic_link_tokens (id, email, token_hash, expires_at, first_name, last_name, password_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [randomUUID(), email, sha256(token), new Date(Date.now() + MAGIC_LINK_TTL_MS),
     cleanName(names.firstName), cleanName(names.lastName), names.passwordHash || null]);
  return token;
}

// Atomically consume the token and resolve the account (creating a STUDENT
// user on first login). Returns { user } or { error }.
// Concurrency: SELECT ... FOR UPDATE serializes concurrent verifies of the
// SAME token; INSERT ... ON CONFLICT makes same-email concurrent first logins
// converge on one user row.
export async function verifyMagicLink(rawToken) {
  if (typeof rawToken !== 'string' || rawToken.length < 20 || rawToken.length > 200) {
    return { error: 'invalid' };
  }
  const hash = sha256(rawToken);
  return withTransaction(async (c) => {
    // Atomic single-statement consumption: the WHERE clause fails the update
    // for already-consumed or expired tokens, so concurrent verifies of the
    // same token can succeed at most once — no row lock needed.
    const { rows: consumed } = await c.query(
      `UPDATE magic_link_tokens SET consumed_at = now()
        WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > now()
        RETURNING *`, [hash]);
    let t = consumed[0];
    if (!t) {
      // Update matched nothing — look up the row to report why.
      const { rows } = await c.query(
        `SELECT * FROM magic_link_tokens WHERE token_hash = $1`, [hash]);
      const ex = rows[0];
      if (!ex) return { error: 'invalid' };
      return { error: ex.consumed_at ? 'consumed' : 'expired' };
    }

    let { rows: users } = await c.query(`SELECT * FROM users WHERE email = $1`, [t.email]);
    let user = users[0];
    if (!user) {
      const display = [t.first_name, t.last_name].filter(Boolean).join(' ').trim()
        || t.email.split('@')[0].slice(0, 80) || 'Student';
      await c.query(
        `INSERT INTO users (id, email, display_name, role, password_hash)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (email) DO NOTHING`,
        [randomUUID(), t.email, display, bootstrapRole(t.email), t.password_hash]);
      ({ rows: users } = await c.query(`SELECT * FROM users WHERE email = $1`, [t.email]));
      user = users[0];
    } else if (t.password_hash && !user.password_hash) {
      // Link-based password enrollment for pre-password accounts.
      await c.query(`UPDATE users SET password_hash=$2 WHERE id=$1`, [user.id, t.password_hash]);
    }
    if (!user) return { error: 'invalid' };
    if (!user.is_active) return { error: 'disabled' };
    await c.query(`UPDATE users SET last_login_at = now(), updated_at = now() WHERE id = $1`, [user.id]);
    const session = await createSession(c, user.id);
    return { user, session };
  });
}

// ---- sessions ---------------------------------------------------------------

async function createSession(client, userId) {
  const token = newToken();
  const id = randomUUID();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await client.query(
    `INSERT INTO auth_sessions (id, user_id, token_hash, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [id, userId, sha256(token), expiresAt]);
  return { token, id, expiresAt };
}

// Session lookup joins users so a deactivated account is rejected even if the
// session row itself is unexpired.
export async function resolveSession(rawToken) {
  if (typeof rawToken !== 'string' || rawToken.length < 20 || rawToken.length > 200) return null;
  const { rows } = await getPool().query(
    `SELECT u.id, u.email, u.display_name, u.role
       FROM auth_sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
        AND u.is_active`,
    [sha256(rawToken)]);
  return rows[0] || null;
}

export async function revokeSession(rawToken) {
  if (typeof rawToken !== 'string') return;
  await getPool().query(
    `UPDATE auth_sessions SET revoked_at = now()
      WHERE token_hash = $1 AND revoked_at IS NULL`, [sha256(rawToken)]);
}

// ---- password login ---------------------------------------------------------

// Email+password sign-in for already-registered accounts. Returns
// { user, session } or { error } — a constant error shape prevents
// account enumeration.
export async function loginPassword(email, password) {
  const em = normalizeEmail(email);
  if (!em || typeof password !== 'string' || !password) return { error: 'credentials' };
  const { rows } = await getPool().query(
    `SELECT * FROM users WHERE email = $1`, [em]);
  const user = rows[0];
  if (!user) return { error: 'credentials' };
  if (!user.is_active) return { error: 'disabled' };
  if (!user.password_hash || !(await verifyPasswordHash(user.password_hash, password))) {
    return { error: 'credentials' };
  }
  const pool = getPool();
  await pool.query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [user.id]);
  const session = await createSession(pool, user.id);
  return { user, session };
}

// ---- guest credentials ------------------------------------------------------

// Mint a fresh guest identity. Returns { guestToken, participantId } — the raw
// token is returned to the client once; only its hash is stored.
export async function mintGuestToken() {
  const participantId = newGuestPid();
  const token = newToken();
  await getPool().query(
    `INSERT INTO guest_tokens (id, participant_id, token_hash, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [randomUUID(), participantId, sha256(token),
     new Date(Date.now() + GUEST_TOKEN_TTL_MS)]);
  return { guestToken: token, participantId };
}

// Resolve a presented guest credential to its server-minted participant id.
export async function resolveGuestToken(rawToken) {
  if (typeof rawToken !== 'string' || rawToken.length < 20 || rawToken.length > 200) return null;
  const { rows } = await getPool().query(
    `UPDATE guest_tokens SET last_seen_at = now()
      WHERE token_hash = $1 AND expires_at > now()
      RETURNING participant_id`, [sha256(rawToken)]);
  return rows[0]?.participant_id || null;
}
