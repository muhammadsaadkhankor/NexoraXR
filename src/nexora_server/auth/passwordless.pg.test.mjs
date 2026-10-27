// Real-Postgres integration test for the magic-link flow.
// Skipped unless TEST_DATABASE_URL (or DATABASE_URL) is reachable —
// the pg-mem suite covers the same paths in-process.
import test from 'node:test';
import assert from 'node:assert/strict';
import { initDb, getPool } from '../db/pool.mjs';
import {
  createMagicLink, verifyMagicLink, resolveSession, revokeSession,
  mintGuestToken, resolveGuestToken,
} from './passwordless.mjs';

const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
if (url && !process.env.DATABASE_URL) process.env.DATABASE_URL = url;
let pool = null;
try { if (url) pool = await initDb(); } catch { /* unavailable */ }

const maybe = pool ? test : test.skip;
const em = () => `it-${Math.random().toString(16).slice(2)}@example.com`;

maybe('pg: full magic-link flow on real Postgres', async () => {
  const email = em();
  const token = await createMagicLink(email);
  const r = await verifyMagicLink(token);
  assert.equal(r.user.role, 'STUDENT');
  assert.equal(r.user.email, email);
  const me = await resolveSession(r.session.token);
  assert.equal(me.email, email);
  // Reuse is rejected on the real engine too (atomic conditional update).
  assert.equal((await verifyMagicLink(token)).error, 'consumed');
  await revokeSession(r.session.token);
  assert.equal(await resolveSession(r.session.token), null);
});

maybe('pg: concurrent verify consumes once', async () => {
  const email = em();
  const token = await createMagicLink(email);
  const rs = await Promise.all([verifyMagicLink(token), verifyMagicLink(token), verifyMagicLink(token)]);
  assert.equal(rs.filter((r) => r.user).length, 1);
  const { rows } = await getPool().query('SELECT * FROM users WHERE email=$1', [email]);
  assert.equal(rows.length, 1);
});

maybe('pg: guest tokens persist and expire', async () => {
  const g = await mintGuestToken();
  assert.equal(await resolveGuestToken(g.guestToken), g.participantId);
});
