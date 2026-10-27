import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { deliverMagicLink, deliveryMode, consoleDeliveryAllowed } from './delivery.mjs';

const ENV = { ...process.env };
beforeEach(() => {
  delete process.env.AUTH_DELIVERY_MODE;
  delete process.env.RESEND_API_KEY;
  delete process.env.EMAIL_FROM;
  delete process.env.NODE_ENV;
});
afterEach(() => { process.env = { ...ENV }; });

test('no mode configured -> unconfigured, never silent console fallback', async () => {
  assert.equal(deliveryMode(), '');
  const r = await deliverMagicLink({ email: 'a@b.c', verifyUrl: 'http://x', ttlMinutes: 10 });
  assert.equal(r.ok, false);
  assert.equal(r.unconfigured, true);
});

test('console mode prints only outside production', async () => {
  process.env.AUTH_DELIVERY_MODE = 'console';
  assert.equal(consoleDeliveryAllowed(), true);
  const r = await deliverMagicLink({ email: 'a@b.c', verifyUrl: 'http://x?t=secret', ttlMinutes: 10 });
  assert.equal(r.ok, true);
  process.env.NODE_ENV = 'production';
  assert.equal(consoleDeliveryAllowed(), false);
  const r2 = await deliverMagicLink({ email: 'a@b.c', verifyUrl: 'http://x?t=secret', ttlMinutes: 10 });
  assert.equal(r2.unconfigured, true); // no silent console in prod
});

test('resend mode without credentials fails explicitly', async () => {
  process.env.AUTH_DELIVERY_MODE = 'resend';
  const r = await deliverMagicLink({ email: 'a@b.c', verifyUrl: 'http://x', ttlMinutes: 10 });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'resend_not_configured');
  assert.equal(r.unconfigured, undefined);
});

test('resend mode sends one POST with auth header; failure surfaces, no fallback', async () => {
  process.env.AUTH_DELIVERY_MODE = 'resend';
  process.env.RESEND_API_KEY = 're_test_key';
  process.env.EMAIL_FROM = 'NexoraXR <onboarding@resend.dev>';
  const calls = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, text: async () => '' };
  };
  try {
    const r = await deliverMagicLink({ email: 'me@x.com', verifyUrl: 'https://app/verify?token=T', ttlMinutes: 10 });
    assert.equal(r.ok, true);
    assert.equal(r.mode, 'resend');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.resend.com/emails');
    assert.equal(calls[0].opts.headers.Authorization, 'Bearer re_test_key');
    const body = JSON.parse(calls[0].opts.body);
    assert.deepEqual(body.to, ['me@x.com']);
    assert.equal(body.from, 'NexoraXR <onboarding@resend.dev>');
    assert.ok(body.html.includes('https://app/verify?token=T'));
  } finally { globalThis.fetch = origFetch; }

  // API error -> explicit failure (caller returns 502, no console fallback)
  globalThis.fetch = async () => ({ ok: false, status: 403, text: async () => '{"name":"validation_error"}' });
  try {
    const r = await deliverMagicLink({ email: 'me@x.com', verifyUrl: 'https://app/v?t=T', ttlMinutes: 10 });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'resend_send_failed');
    assert.equal(r.status, 403);
  } finally { globalThis.fetch = origFetch; }

  // Network throw -> explicit failure
  globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };
  try {
    const r = await deliverMagicLink({ email: 'me@x.com', verifyUrl: 'https://app/v?t=T', ttlMinutes: 10 });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'resend_request_failed');
  } finally { globalThis.fetch = origFetch; }
});
