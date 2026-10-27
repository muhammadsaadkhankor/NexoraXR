// Passwordless auth routes:
//   POST /auth/request-link  {email}   -> generic 200 (no enumeration)
//   GET  /auth/verify?token= -> confirm page (does NOT consume the token)
//   POST /auth/verify        {token}   -> consumes token, sets session cookie
//   GET  /auth/me            -> {user}|{user:null}
//   POST /auth/logout        -> revoke session, clear cookie

import crypto from 'node:crypto';
import { Router } from 'express';
import {
  normalizeEmail, createMagicLink, verifyMagicLink, revokeSession,
  hashPassword, loginPassword, MAGIC_LINK_TTL_MS,
} from './passwordless.mjs';
import { deliverMagicLink, consoleDeliveryAllowed } from './delivery.mjs';
import {
  attachUser, requireAuth, sessionCookieHeader, clearCookieHeader,
  parseCookies, SESSION_COOKIE,
} from './sessionMiddleware.mjs';
import { rateLimit, clientIp } from './rateLimit.mjs';
import { dbAvailable, getPool } from '../db/pool.mjs';

const router = Router();
router.use(attachUser);

const requestLinkLimit = rateLimit({
  windowMs: 15 * 60 * 1000, max: 5,
  keyFn: (req) => `link:${clientIp(req)}:${normalizeEmail(req.body?.email) || 'bad'}`,
});
const requestLinkIpLimit = rateLimit({
  windowMs: 15 * 60 * 1000, max: 30, keyFn: (req) => `linkip:${clientIp(req)}`,
});
const verifyLimit = rateLimit({
  windowMs: 60 * 1000, max: 20, keyFn: (req) => `verify:${clientIp(req)}`,
});

const GENERIC_OK = { ok: true, message: 'If that address can sign in, a confirmation link was generated.' };

function publicUser(u) {
  return u && { id: u.id, email: u.email, displayName: u.display_name, role: u.role };
}

function verifyBaseUrl(req) {
  // Explicit public base wins; fall back to the request origin (the backend's
  // own port serves the GET confirm page directly in dev).
  return (process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`).trim().replace(/\/$/, '');
}

router.post('/request-link', requestLinkIpLimit, requestLinkLimit, async (req, res) => {
  if (!dbAvailable()) {
    return res.status(503).json({ error: 'Authentication is unavailable (no database).' });
  }
  const email = normalizeEmail(req.body?.email);
  if (!email) return res.status(400).json({ error: 'A valid email address is required.' });
  // Optional password → argon2id hash rides on the link row. Accounts that
  // already have a password should sign in directly instead.
  let passwordHash = null;
  const pw = req.body?.password;
  if (pw !== undefined && pw !== null && pw !== '') {
    if (typeof pw !== 'string' || pw.length < 8 || pw.length > 200) {
      return res.status(400).json({ error: 'Password must be 8–200 characters.' });
    }
    const { rows } = await getPool().query(
      'SELECT password_hash FROM users WHERE email=$1', [email]);
    if (rows[0]?.password_hash) {
      return res.status(409).json({ error: 'This account already has a password — sign in with email and password.' });
    }
    passwordHash = await hashPassword(pw);
  }
  try {
    const token = await createMagicLink(email, {
      firstName: req.body?.firstName, lastName: req.body?.lastName, passwordHash,
    });
    const delivered = await deliverMagicLink({
      email,
      verifyUrl: `${verifyBaseUrl(req)}/auth/verify?token=${token}`,
      ttlMinutes: MAGIC_LINK_TTL_MS / 60000,
    });
    if (!delivered.ok && !delivered.unconfigured) {
      // A configured channel failed — say so instead of pretending it worked.
      return res.status(502).json({
        error: 'Could not send the sign-in email. Please try again shortly.' });
    }
    if (!delivered.ok) {
      console.warn(`[auth] magic link for ${email} created but NOT delivered — no delivery mode configured`);
    }
    res.json(GENERIC_OK);
  } catch (err) {
    console.error('[auth] request-link failed:', err.message);
    res.status(500).json({ error: 'Failed to process request.' });
  }
});

// GET renders a confirmation page — the token is consumed only by the
// deliberate POST below, so mail previewers/scanners can't burn it.
router.get('/verify', (req, res) => {
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  res.type('html').send(`<!doctype html><html><head><meta charset="utf-8">
<title>NexoraXR — Confirm sign in</title>
<style>body{font-family:system-ui;background:#0b0f1a;color:#e5e7eb;display:flex;min-height:100vh;align-items:center;justify-content:center}
.card{background:#141a2e;border:1px solid #2a3352;border-radius:12px;padding:32px;max-width:420px;text-align:center}
button{background:#7c3aed;color:#fff;border:0;border-radius:8px;padding:12px 24px;font-size:16px;cursor:pointer}
button:hover{background:#8b5cf6}.err{color:#f87171}h1{font-size:20px}</style></head>
<body><div class="card"><h1>Signing you in to NexoraXR…</h1>
<p id="msg">Hold on — completing your sign-in.</p>
<button id="go" style="display:none">Continue</button>
<script>
const msg = document.getElementById('msg');
const go = document.getElementById('go');
// Auto-submit: the JS POST (not the GET) consumes the token, so mail
// prefetchers that don't run JS still can't burn it — while a real browser
// goes straight through without any click.
(async () => {
  try {
    const r = await fetch('/auth/verify', { method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ token: ${JSON.stringify(token)} }) });
    const d = await r.json();
    if (!r.ok) {
      msg.innerHTML = '<span class="err">' + (d.error || 'Sign-in failed') + '</span>';
      go.style.display = 'inline-block';
      go.textContent = 'Back to app';
      go.onclick = () => { window.location.href = '/'; };
      return;
    }
    msg.textContent = 'Signed in — redirecting…';
    window.location.href = '/';
  } catch (e) {
    msg.innerHTML = '<span class="err">Sign-in failed. Try again.</span>';
    go.style.display = 'inline-block';
    go.onclick = () => { window.location.href = '/'; };
  }
})();
</script></div></body></html>`);
});

router.post('/verify', verifyLimit, async (req, res) => {
  if (!dbAvailable()) return res.status(503).json({ error: 'Authentication is unavailable.' });
  try {
    const result = await verifyMagicLink(req.body?.token);
    if (result.error) {
      const msg = {
        invalid: 'This link is invalid.',
        consumed: 'This link was already used.',
        expired: 'This link has expired. Request a new one.',
        disabled: 'This account has been deactivated.',
      }[result.error] || 'Sign-in failed.';
      return res.status(401).json({ error: msg });
    }
    const secure = req.secure || req.get('x-forwarded-proto') === 'https';
    res.set('Set-Cookie', sessionCookieHeader(result.session.token, result.session.expiresAt, secure));
    res.json({ user: publicUser(result.user) });
  } catch (err) {
    console.error('[auth] verify failed:', err.message);
    res.status(500).json({ error: 'Sign-in failed.' });
  }
});

// Email+password login for registered accounts (post-registration path).
const loginLimit = rateLimit({
  windowMs: 60 * 1000, max: 10, keyFn: (req) => `login:${clientIp(req)}`,
});
router.post('/login', loginLimit, async (req, res) => {
  if (!dbAvailable()) return res.status(503).json({ error: 'Authentication is unavailable.' });
  try {
    const result = await loginPassword(req.body?.email, req.body?.password);
    if (result.error === 'disabled') {
      return res.status(403).json({ error: 'This account has been deactivated.' });
    }
    if (result.error) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }
    const secure = req.secure || req.get('x-forwarded-proto') === 'https';
    res.set('Set-Cookie', sessionCookieHeader(result.session.token, result.session.expiresAt, secure));
    res.json({ user: publicUser(result.user) });
  } catch (err) {
    console.error('[auth] login failed:', err.message);
    res.status(500).json({ error: 'Sign-in failed.' });
  }
});

router.get('/me', (req, res) => {
  res.json({ user: publicUser(req.user), consoleDelivery: consoleDeliveryAllowed() });
});

router.post('/logout', async (req, res) => {
  if (dbAvailable()) {
    try { await revokeSession(parseCookies(req.headers.cookie)[SESSION_COOKIE]); } catch {}
  }
  const secure = req.secure || req.get('x-forwarded-proto') === 'https';
  res.set('Set-Cookie', clearCookieHeader(secure));
  res.json({ ok: true });
});

// Elevation: an authenticated user presents the operator-configured claim
// token (NXR_ADMIN_CLAIM_TOKEN) to become SUPER_ADMIN. Timing-safe compare;
// tight rate limit; disabled entirely when the token isn't configured.
const claimLimit = rateLimit({
  windowMs: 60 * 1000, max: 5, keyFn: (req) => `claim:${clientIp(req)}`,
});
router.post('/claim-admin', claimLimit, requireAuth, async (req, res) => {
  const secret = process.env.NXR_ADMIN_CLAIM_TOKEN;
  if (!secret) return res.status(403).json({ error: 'Admin claim is not configured on this server.' });
  const presented = String(req.body?.token || '');
  const a = crypto.createHash('sha256').update(presented).digest();
  const b = crypto.createHash('sha256').update(secret).digest();
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(403).json({ error: 'Invalid admin token.' });
  }
  try {
    await getPool().query(`UPDATE users SET role='SUPER_ADMIN' WHERE id=$1`, [req.user.id]);
    console.log(`[admin] ${req.user.email} claimed SUPER_ADMIN`);
    res.json({ ok: true, role: 'SUPER_ADMIN' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to elevate account.' });
  }
});

export default router;
