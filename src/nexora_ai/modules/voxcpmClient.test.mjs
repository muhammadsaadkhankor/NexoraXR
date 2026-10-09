// voxcpmClient tests — fetch and Whisper detection are mocked; no network/GPU.
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Point the registry at a fixture with base + per-language voices BEFORE
// importing the client (the registry is read lazily per call, but pin it
// explicitly so tests don't depend on repo-local assets).
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voxreg_'));
const refWav = path.join(fixtureDir, 'ref.wav');
fs.writeFileSync(refWav, Buffer.from('RIFF'));
fs.writeFileSync(
  path.join(fixtureDir, 'registry.json'),
  JSON.stringify({
    abed101: { prompt_wav: refWav, prompt_text: 'english reference text' },
    abed101_ar: { prompt_wav: refWav, prompt_text: 'نص مرجعي عربي' },
  })
);
process.env.VOXCPM_VOICE_REGISTRY = path.join(fixtureDir, 'registry.json');

const { synthesize, synthesizeVerified } = await import('./voxcpmClient.mjs');

const okResponse = () => ({
  ok: true,
  arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
});

test('synthesize sends ref_audio AND ref_text plus language', async () => {
  let sent;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => { sent = JSON.parse(opts.body); return okResponse(); };
  try {
    const wav = await synthesize('مرحبا', 'abed101', 'ar');
    assert.ok(wav.length > 0);
    assert.equal(sent.ref_audio, `file://${refWav}`);
    assert.equal(sent.ref_text, 'نص مرجعي عربي'); // per-language entry preferred
    assert.equal(sent.language, 'ar');
  } finally { globalThis.fetch = origFetch; }
});

test('synthesize falls back to base voice ref_text for unregistered language', async () => {
  let sent;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => { sent = JSON.parse(opts.body); return okResponse(); };
  try {
    await synthesize('bonjour', 'abed101', 'fr');
    assert.equal(sent.ref_text, 'english reference text'); // no abed101_fr -> base
    assert.equal(sent.ref_audio, `file://${refWav}`);
  } finally { globalThis.fetch = origFetch; }
});

test('synthesizeVerified: wrong detected language triggers retry until correct', async () => {
  let calls = 0;
  const wav = await synthesizeVerified('text', 'abed101', 'ar', {
    synthesize: async () => { calls++; return Buffer.from('wav'); },
    detect: async () => (calls === 1 ? 'zh' : 'ar'), // first drifts, second ok
  });
  assert.equal(calls, 2);
  assert.ok(wav.length > 0);
});

test('synthesizeVerified: correct language succeeds without retry', async () => {
  let calls = 0;
  await synthesizeVerified('text', 'abed101', 'fr', {
    synthesize: async () => { calls++; return Buffer.from('wav'); },
    detect: async () => 'fr',
  });
  assert.equal(calls, 1);
});

test('synthesizeVerified: retry exhaustion fails safely', async () => {
  let calls = 0;
  await assert.rejects(
    synthesizeVerified('text', 'abed101', 'ar', {
      synthesize: async () => { calls++; return Buffer.from('wav'); },
      detect: async () => 'zh',
    }),
    /language mismatch/i
  );
  assert.equal(calls, 3); // 1 initial + 2 retries, bounded
});

test('synthesizeVerified: English skips detection entirely', async () => {
  let detectCalls = 0;
  const wav = await synthesizeVerified('hello', 'abed101', 'en', {
    synthesize: async () => Buffer.from('wav'),
    detect: async () => { detectCalls++; return 'en'; },
  });
  assert.equal(detectCalls, 0);
  assert.ok(wav.length > 0);
});

test('synthesizeVerified: detection result is returned only as accept/reject — never mutates caller state', async () => {
  // detect() returns a code; synthesizeVerified exposes no language output.
  const result = await synthesizeVerified('text', 'abed101', 'de', {
    synthesize: async () => Buffer.from('wav'),
    detect: async () => 'de',
  });
  assert.ok(Buffer.isBuffer(result)); // just audio bytes
});

test('synthesizeVerified: a mid-segment language blip is rejected (windowed)', async () => {
  // Regression: dominant-language detection passed a mostly-Arabic clip with a
  // few-second Chinese drift; windowed detection must reject and retry.
  let calls = 0;
  const wav = await synthesizeVerified('نص', 'v', 'ar', {
    synthesize: async () => Buffer.from('wav'),
    detect: async () => (++calls === 1 ? ['ar', 'zh', 'ar'] : ['ar', 'ar', 'ar']),
  });
  assert.equal(calls, 2); // first wav rejected due to the 'zh' window
  assert.ok(wav.length);
});
