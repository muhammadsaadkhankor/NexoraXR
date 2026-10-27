// SUPER_ADMIN management API (mounted at /admin).
//   GET   /admin/users          -> all registered users + session counts
//   PATCH /admin/users/:id      -> { role?, isActive? }
//
// requireRole('SUPER_ADMIN') wraps the whole router — no client-side role is
// ever trusted. Deactivation immediately kills sessions: resolveSession joins
// users.is_active, and we also stamp revoked_at on every live session row.

import { Router } from 'express';
import { requireRole } from '../auth/sessionMiddleware.mjs';
import { getPool, dbAvailable } from '../db/pool.mjs';
import { rateLimit, clientIp } from '../auth/rateLimit.mjs';
import { readBranding, saveAsset } from '../branding/store.mjs';

const ROLES = ['SUPER_ADMIN', 'INSTRUCTOR', 'STUDENT'];
const router = Router();

router.use(rateLimit({ windowMs: 60 * 1000, max: 60, keyFn: (req) => `admin:${clientIp(req)}` }));
router.use((req, res, next) => dbAvailable() ? next() : res.status(503).json({ error: 'Database unavailable' }));
router.use(requireRole('SUPER_ADMIN'));

router.get('/users', async (_req, res) => {
  try {
    const { rows } = await getPool().query(
      `SELECT u.id, u.email, u.display_name, u.role, u.is_active,
              u.created_at, u.last_login_at,
              (SELECT COUNT(*)::int FROM auth_sessions s
                WHERE s.user_id = u.id AND s.revoked_at IS NULL AND s.expires_at > now()) AS active_sessions
       FROM users u ORDER BY u.created_at`);
    res.json({ users: rows.map((u) => ({ ...u, displayName: u.display_name, isActive: u.is_active })) });
  } catch (err) {
    console.error('[admin] list users failed:', err.message);
    res.status(500).json({ error: 'Failed to list users' });
  }
});

// Permanent delete: removes the user row (auth_sessions cascade via FK) and
// purges any magic-link tokens issued to that email. Irreversible.
router.delete('/users/:id', async (req, res) => {
  const targetId = req.params.id;
  if (!/^[0-9a-f-]{36}$/i.test(targetId)) return res.status(400).json({ error: 'Invalid user id' });
  if (targetId === req.user.id) {
    return res.status(400).json({ error: 'You cannot delete your own account.' });
  }
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(`SELECT email FROM users WHERE id=$1`, [targetId]);
    if (!rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'User not found' }); }
    // Sessions die with the row (ON DELETE CASCADE); link tokens keyed by
    // email need an explicit purge.
    await client.query(`DELETE FROM magic_link_tokens WHERE email=$1`, [rows[0].email]);
    await client.query(`DELETE FROM users WHERE id=$1`, [targetId]);
    await client.query('COMMIT');
    console.log(`[admin] ${req.user.email} deleted user ${targetId} (${rows[0].email})`);
    res.json({ ok: true });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('[admin] delete user failed:', err.message);
    res.status(500).json({ error: 'Delete failed' });
  } finally {
    client.release();
  }
});

router.patch('/users/:id', async (req, res) => {
  const targetId = req.params.id;
  if (!/^[0-9a-f-]{36}$/i.test(targetId)) return res.status(400).json({ error: 'Invalid user id' });

  const { role, isActive } = req.body || {};
  if (role !== undefined && !ROLES.includes(role)) {
    return res.status(400).json({ error: `role must be one of ${ROLES.join(', ')}` });
  }
  // Self-protection: an admin can't lock or demote themselves out.
  if (targetId === req.user.id && (isActive === false || (role && role !== 'SUPER_ADMIN'))) {
    return res.status(400).json({ error: 'You cannot deactivate or demote your own account.' });
  }

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (role !== undefined) {
      const r = await client.query(
        `UPDATE users SET role=$2 WHERE id=$1 RETURNING id`, [targetId, role]);
      if (!r.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'User not found' }); }
    }
    if (isActive !== undefined) {
      const r = await client.query(
        `UPDATE users SET is_active=$2 WHERE id=$1 RETURNING id`, [targetId, !!isActive]);
      if (!r.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'User not found' }); }
      if (isActive === false) {
        // Hard revoke all live sessions — belt & suspenders on top of the
        // is_active join in resolveSession.
        await client.query(
          `UPDATE auth_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL`, [targetId]);
      }
    }
    await client.query('COMMIT');
    console.log(`[admin] ${req.user.email} updated user ${targetId}: role=${role} isActive=${isActive}`);
    res.json({ ok: true });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    res.status(500).json({ error: 'Update failed' });
  } finally {
    client.release();
  }
});

// Branding: {appName?, logo?: dataUrl|null, favicon?: dataUrl|null}
// null clears an asset back to the default.
router.patch('/branding', async (req, res) => {
  try {
    const { appName, logo, favicon } = req.body || {};
    if (appName !== undefined) {
      const name = String(appName).trim().slice(0, 60);
      if (!name) return res.status(400).json({ error: 'appName must be 1–60 characters' });
      await getPool().query(
        `INSERT INTO app_settings (key, value, updated_at, updated_by)
         VALUES ('app_name', $1, now(), $2)
         ON CONFLICT (key) DO UPDATE SET value=$1, updated_at=now(), updated_by=$2`,
        [name, req.user.id]);
    }
    if (logo !== undefined) await saveAsset('logo', logo, req.user.id);
    if (favicon !== undefined) await saveAsset('favicon', favicon, req.user.id);
    console.log(`[admin] ${req.user.email} updated branding`);
    res.json({ ok: true, branding: await readBranding() });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Invalid branding payload' });
  }
});

export default router;
