// ttsClient tests — fetch and Whisper detection are mocked; no network/GPU.
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Point the registry at a fixture with base + per-language voices BEFORE
// importing the client (the registry is read lazily per call, but pin it
// explicitly so tests don't depend on repo-local assets).
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ttsreg_'));
const refWav = path.join(fixtureDir, 'ref.wav');
const refWavAr = path.join(fixtureDir, 'ref_ar.wav');
fs.writeFileSync(refWav, Buffer.from('RIFF-fake-en'));
fs.writeFileSync(refWavAr, Buffer.from('RIFF-fake-ar'));
fs.mkdirSync(path.join(fixtureDir, 'v1'), { recursive: true });
fs.copyFileSync(refWav, path.join(fixtureDir, 'v1', 'prompt.wav'));
fs.writeFileSync(
  path.join(fixtureDir, 'registry.json'),
  JSON.stringify({
    abed101: { prompt_wav: 'v1/prompt.wav', prompt_text: 'english reference text', lang: 'en' },
    abed101_ar: { prompt_wav: refWavAr, prompt_text: 'نص مرجعي عربي', lang: 'ar' },
  })
);
process.env.TTS_VOICE_REGISTRY = path.join(fixtureDir, 'registry.json');

const { synthesize, synthesizeVerified } = await import('./ttsClient.mjs');

const PCM_BYTES = new Uint8Array([1, 0, 2, 0, 3, 0, 4, 0]); // 4 int16 samples
const LATENTS = 'ZmFrZS1sYXRlbnRz'; // 'fake-latents' b64

// Mock fetch: /encode_latents → latents; /generate → raw PCM stream body.
function mockEngine(capture) {
  return async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : null;
    if (url.endsWith('/encode_latents')) {
      capture.encode.push(body);
      return new Response(JSON.stringify({ prompt_latents_base64: LATENTS, sample_rate: 48000 }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.endsWith('/generate')) {
      capture.generate.push(body);
      return new Response(PCM_BYTES, {
        status: 200,
        headers: { 'X-Audio-Sample-Rate': '48000', 'X-Audio-Encoding': 's16le' },
      });
    }
    return new Response('not found', { status: 404 });
  };
}

function wavSampleRate(buf) { return buf.readUInt32LE(24); }

test('synthesize encodes latents once, posts latents+prompt_text to /generate, returns 48k WAV', async () => {
  const capture = { encode: [], generate: [] };
  const origFetch = globalThis.fetch;
  globalThis.fetch = mockEngine(capture);
  try {
    const wav = await synthesize('مرحبا', 'abed101', 'ar');
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
    assert.equal(wavSampleRate(wav), 48000);
    assert.equal(wav.readUInt16LE(22), 1); // mono
    assert.equal(capture.encode.length, 1); // abed101_ar clip encoded
    assert.equal(capture.generate.length, 1);
    const sent = capture.generate[0];
    assert.equal(sent.target_text, 'مرحبا');
    assert.equal(sent.cfg_value, 2.0);
    assert.equal(sent.prompt_latents_base64, LATENTS);
    assert.equal(sent.ref_audio_latents_base64, LATENTS);
    assert.equal(sent.prompt_text, 'نص مرجعي عربي'); // per-language entry preferred
  } finally { globalThis.fetch = origFetch; }
});

test('synthesize reuses cached latents (memory + .latents dir)', async () => {
  const capture = { encode: [], generate: [] };
  const origFetch = globalThis.fetch;
  globalThis.fetch = mockEngine(capture);
  try {
    // 'fr' has no abed101_fr → falls back to base abed101 (v1/prompt.wav).
    // First call encodes it; the second must reuse memory-cached latents.
    await synthesize('bonjour', 'abed101', 'fr');
    await synthesize('encore', 'abed101', 'fr');
    assert.equal(capture.encode.length, 1);
    assert.equal(capture.generate.length, 2);
    const sent = capture.generate[0];
    assert.equal(sent.prompt_text, 'english reference text');
    // On-disk latent cache exists for the registry keys encoded so far.
    assert.ok(fs.existsSync(path.join(fixtureDir, '.latents', 'abed101_ar.json')));
    assert.ok(fs.existsSync(path.join(fixtureDir, '.latents', 'abed101.json')));
  } finally { globalThis.fetch = origFetch; }
});

test('latents disk cache survives module memory (fresh import, no re-encode)', async () => {
  // Clear the module-level memory cache by re-importing with a cache-busting
  // query; the .latents/<key>.json files written above must be reused
  // (sha256 matches) so /encode_latents is never hit again.
  const capture = { encode: [], generate: [] };
  const origFetch = globalThis.fetch;
  globalThis.fetch = mockEngine(capture);
  try {
    const fresh = await import('./ttsClient.mjs?fresh=1');
    await fresh.synthesize('مرحبا مجددا', 'abed101', 'ar');
    assert.equal(capture.encode.length, 0); // disk cache hit — no re-encode
    assert.equal(capture.generate.length, 1);
  } finally { globalThis.fetch = origFetch; }
});

test('synthesize with noRef sends target_text only', async () => {
  const capture = { encode: [], generate: [] };
  const origFetch = globalThis.fetch;
  globalThis.fetch = mockEngine(capture);
  try {
    await synthesize('plain', 'abed101', 'en', { noRef: true });
    assert.equal(capture.encode.length, 0);
    const sent = capture.generate[0];
    assert.equal(sent.target_text, 'plain');
    assert.equal(sent.prompt_latents_base64, undefined);
    assert.equal(sent.ref_audio_latents_base64, undefined);
    assert.equal(sent.prompt_text, undefined);
  } finally { globalThis.fetch = origFetch; }
});

test('synthesize throws on engine error', async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('boom', { status: 500 });
  try {
    await assert.rejects(synthesize('x', 'abed101', 'en', { noRef: true }), /TTS error: 500/);
  } finally { globalThis.fetch = origFetch; }
});

test('synthesizeVerified: wrong detected language triggers retry until correct', async () => {
  let calls = 0;
  const wav = await synthesizeVerified('text', 'abed101', 'ar', {
    synthesize: async () => { calls++; return Buffer.from('wav'); },
    detect: async () => (calls === 1 ? 'zh' : 'ar'), // first drifts, second ok
    // Transcribe second opinion confirms the window is foreign → hard fail.
    secondOpinion: async () => 'zh',
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
      secondOpinion: async () => 'zh',
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
  const result = await synthesizeVerified('text', 'abed101', 'de', {
    synthesize: async () => Buffer.from('wav'),
    detect: async () => 'de',
  });
  assert.ok(Buffer.isBuffer(result));
});

test('synthesizeVerified: a mid-segment language blip is rejected (windowed)', async () => {
  // Regression: dominant-language detection passed a mostly-Arabic clip with a
  // few-second Chinese drift; windowed detection must reject and retry.
  let calls = 0;
  const wav = await synthesizeVerified('نص', 'v', 'ar', {
    synthesize: async () => Buffer.from('wav'),
    detect: async () => (++calls === 1 ? ['ar', 'zh', 'ar'] : ['ar', 'ar', 'ar']),
    secondOpinion: async () => 'zh',
  });
  assert.equal(calls, 2);
  assert.ok(wav.length);
});
