import test from 'node:test';
import assert from 'node:assert/strict';
import { newDb } from 'pg-mem';
import { initDb } from '../db/pool.mjs';
import {
  normalizeEmail, createMagicLink, verifyMagicLink, resolveSession,
  revokeSession, mintGuestToken, resolveGuestToken, sha256,
  MAGIC_LINK_TTL_MS,
} from './passwordless.mjs';
import { consoleDeliveryAllowed } from './delivery.mjs';
import { getPool } from '../db/pool.mjs';

function makePgMemPool() {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  return new Pool();
}

const EMAIL = 'Student1@Example.com';
const norm = normalizeEmail(EMAIL);

test.beforeEach(async () => { await initDb(makePgMemPool()); });

test('email normalization and validation', () => {
  assert.equal(norm, 'student1@example.com');
  assert.equal(normalizeEmail('not-an-email'), null);
  assert.equal(normalizeEmail('a@b.c'), null); // TLD must be 2+ chars
  assert.equal(normalizeEmail('a@b.co'), 'a@b.co');
  assert.equal(normalizeEmail(42), null);
});

test('new email verifies into a STUDENT account', async () => {
  const token = await createMagicLink('new@example.com');
  const r = await verifyMagicLink(token);
  assert.equal(r.user.role, 'STUDENT');
  assert.equal(r.user.email, 'new@example.com');
  assert.ok(r.user.is_active);
});

test('existing email signs into the same account, role preserved', async () => {
  await verifyMagicLink(await createMagicLink('x@example.com'));
  await getPool().query(`UPDATE users SET role='INSTRUCTOR' WHERE email='x@example.com'`);
  const r = await verifyMagicLink(await createMagicLink('x@example.com'));
  assert.equal(r.user.role, 'INSTRUCTOR');
  const { rows } = await getPool().query(`SELECT * FROM users WHERE email='x@example.com'`);
  assert.equal(rows.length, 1); // no duplicate account
});

test('registration can never create an elevated role', async () => {
  delete process.env.NXR_ADMIN_EMAILS; delete process.env.NXR_INSTRUCTOR_EMAILS;
  const r = await verifyMagicLink(await createMagicLink('sneaky@example.com'));
  assert.equal(r.user.role, 'STUDENT');
});

test('token reuse is rejected', async () => {
  const token = await createMagicLink('r@example.com');
  const first = await verifyMagicLink(token);
  assert.ok(first.user);
  const second = await verifyMagicLink(token);
  assert.equal(second.error, 'consumed');
});

test('expired token is rejected', async () => {
  const token = await createMagicLink('e@example.com');
  await getPool().query(`UPDATE magic_link_tokens SET expires_at = now() - interval '1 minute'`);
  const r = await verifyMagicLink(token);
  assert.equal(r.error, 'expired');
});

test('unknown/malformed tokens rejected', async () => {
  assert.equal((await verifyMagicLink('bogus-token-value-that-is-long-enough')).error, 'invalid');
  assert.equal((await verifyMagicLink('short')).error, 'invalid');
  assert.equal((await verifyMagicLink(null)).error, 'invalid');
});

test('concurrent verify of the same token yields one user, one consumption', async () => {
  const token = await createMagicLink('cc@example.com');
  const results = await Promise.all([
    verifyMagicLink(token), verifyMagicLink(token), verifyMagicLink(token),
  ]);
  const ok = results.filter((r) => r.user);
  const { rows } = await getPool().query(`SELECT * FROM users WHERE email='cc@example.com'`);
  assert.equal(rows.length, 1);
  // pg-mem serializes queries anyway; the contract is "at most one succeeds".
  assert.ok(ok.length <= 1);
});

test('disabled account rejected at verify and session resolve', async () => {
  const r = await verifyMagicLink(await createMagicLink('d@example.com'));
  await getPool().query(`UPDATE users SET is_active=false WHERE email='d@example.com'`);
  const again = await verifyMagicLink(await createMagicLink('d@example.com'));
  assert.equal(again.error, 'disabled');
  assert.equal(await resolveSession(r.session.token), null);
});

test('session resolve + revoke', async () => {
  const r = await verifyMagicLink(await createMagicLink('s@example.com'));
  const me = await resolveSession(r.session.token);
  assert.equal(me.email, 's@example.com');
  await revokeSession(r.session.token);
  assert.equal(await resolveSession(r.session.token), null);
});

test('guest token mint + resolve + expiry', async () => {
  const g = await mintGuestToken();
  assert.ok(g.participantId.startsWith('gst_'));
  assert.equal(await resolveGuestToken(g.guestToken), g.participantId);
  assert.equal(await resolveGuestToken('wrong-token-value-that-is-long-enough'), null);
  await getPool().query(`UPDATE guest_tokens SET expires_at = now() - interval '1 minute'`);
  assert.equal(await resolveGuestToken(g.guestToken), null);
});

test('tokens stored only as sha256 hashes', async () => {
  const token = await createMagicLink('h@example.com');
  const { rows } = await getPool().query(`SELECT token_hash FROM magic_link_tokens`);
  assert.equal(rows[0].token_hash, sha256(token));
  assert.notEqual(rows[0].token_hash, token);
});

test('console delivery only outside production and only when configured', () => {
  const mode = process.env.AUTH_DELIVERY_MODE, env = process.env.NODE_ENV;
  process.env.AUTH_DELIVERY_MODE = 'console'; process.env.NODE_ENV = 'development';
  assert.equal(consoleDeliveryAllowed(), true);
  process.env.NODE_ENV = 'production';
  assert.equal(consoleDeliveryAllowed(), false);
  process.env.AUTH_DELIVERY_MODE = ''; process.env.NODE_ENV = 'development';
  assert.equal(consoleDeliveryAllowed(), false);
  process.env.AUTH_DELIVERY_MODE = mode; process.env.NODE_ENV = env;
});
