// POST /api/recap input-validation + cache-key tests — run with: npm test
// Exercises resolveRecapMaterial/recapCacheKey directly (validation runs before
// any LLM/TTS work, so these tests need no Ollama/VoxCPM).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRecapMaterial, recapCacheKey } from './lectureRoutes.mjs';

const LEC = 'Lecture_1'; // exists in profbrain/lectures

test('negative fromSegment rejected', async () => {
  const r = await resolveRecapMaterial(LEC, 'en', -1, 2);
  assert.equal(r.status, 400);
});

test('fractional segment rejected', async () => {
  const r = await resolveRecapMaterial(LEC, 'en', 0, 1.5);
  assert.equal(r.status, 400);
});

test('string segment rejected', async () => {
  const r = await resolveRecapMaterial(LEC, 'en', 0, '2');
  assert.equal(r.status, 400);
});

test('fromSegment > toSegment rejected', async () => {
  const r = await resolveRecapMaterial(LEC, 'en', 3, 1);
  assert.equal(r.status, 400);
});

test('toSegment beyond manifest rejected', async () => {
  const r = await resolveRecapMaterial(LEC, 'en', 0, 9999);
  assert.equal(r.status, 400);
});

test('unknown lecture -> 404', async () => {
  const r = await resolveRecapMaterial('Lecture_9999', 'en', 0, 0);
  assert.equal(r.status, 404);
});

test('path-traversal lectureId rejected before touching the filesystem', async () => {
  const r = await resolveRecapMaterial('../../etc/passwd', 'en', 0, 0);
  assert.equal(r.status, 400);
  assert.match(r.error, /lectureId/i);
});

test('unsupported language rejected', async () => {
  const r = await resolveRecapMaterial(LEC, 'xx', 0, 2);
  assert.equal(r.status, 400);
  assert.match(r.error, /language/i);
});

test('valid range resolves segment texts', async () => {
  const r = await resolveRecapMaterial(LEC, 'en', 0, 1);
  assert.equal(r.error, undefined);
  assert.equal(r.lang, 'en');
  assert.equal(r.texts.length, 2);
  assert.ok(r.texts.every((t) => typeof t === 'string' && t.length > 0));
});

test('cache key changes when source text changes (stale recap impossible)', () => {
  const a = recapCacheKey('Lecture_1', 0, 2, 'old material text');
  const b = recapCacheKey('Lecture_1', 0, 2, 'regenerated material text');
  const c = recapCacheKey('Lecture_1', 0, 2, 'old material text');
  assert.notEqual(a, b);
  assert.equal(a, c); // same inputs still hit the cache
});

// --- /api/ask room-language lock --------------------------------------------

import { buildAskPrompt } from './lectureRoutes.mjs';

test('ask prompt forces Arabic answers for an English question (room=ar)', () => {
  const p = buildAskPrompt('', 'What is DCT?', 'ar');
  assert.match(p, /ONLY in Arabic/);
});

test('ask prompt forces French answers (room=fr)', () => {
  const p = buildAskPrompt('', 'question', 'fr');
  assert.match(p, /ONLY in French/);
});

test('ask prompt supports Chinese (room=zh)', () => {
  const p = buildAskPrompt('', 'question', 'zh');
  assert.match(p, /ONLY in Chinese/);
});

test('resolveRecapMaterial still rejects hi (not offered)', async () => {
  const r = await resolveRecapMaterial('Lecture_1', 'hi', 0, 1);
  assert.equal(r.status, 400);
});


