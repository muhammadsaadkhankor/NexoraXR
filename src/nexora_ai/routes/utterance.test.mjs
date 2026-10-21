// Unit tests for the dynamic-utterance pipeline's pure parts — no Ollama,
// no TTS, no sockets. Generation itself is exercised by the server e2e
// fallback tests and manual runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveUtteranceMaterial,
  utteranceCacheKey,
  buildUtterancePrompt,
  UTTERANCE_PURPOSES,
} from './lectureRoutes.mjs';

const LID = 'Lecture_1';

test('valid grounded request resolves only the referenced segments', async () => {
  const r = await resolveUtteranceMaterial(LID, 'en', [0, 2]);
  assert.equal(r.lang, 'en');
  assert.equal(r.texts.length, 2);
  assert.ok(r.texts[0].includes('welcome'));
  assert.equal(r.manifest.lectureId, LID);
});

test('invalid segment ref rejected', async () => {
  const r = await resolveUtteranceMaterial(LID, 'en', [0, 999]);
  assert.equal(r.status, 400);
  assert.match(r.error, /999/);
});

test('invalid lectureId rejected', async () => {
  const r = await resolveUtteranceMaterial('../etc', 'en', [0]);
  assert.equal(r.status, 400);
});

test('unsupported language rejected', async () => {
  const r = await resolveUtteranceMaterial(LID, 'hi', [0]);
  assert.equal(r.status, 400);
  const r2 = await resolveUtteranceMaterial(LID, 'klingon', [0]);
  assert.equal(r2.status, 400);
});

test('changed source content changes the cache key', () => {
  const base = {
    lectureId: LID, lang: 'en', purpose: 'opening', topicId: 't0',
    sourceSegmentIds: [0], instruction: 'x', material: 'abc',
  };
  const k1 = utteranceCacheKey(base);
  assert.equal(k1, utteranceCacheKey({ ...base }));
  assert.notEqual(k1, utteranceCacheKey({ ...base, material: 'abc changed' }));
  assert.notEqual(k1, utteranceCacheKey({ ...base, purpose: 'transition' }));
  assert.notEqual(k1, utteranceCacheKey({ ...base, lang: 'ar' }));
  assert.notEqual(k1, utteranceCacheKey({ ...base, sourceSegmentIds: [0, 1] }));
  assert.match(k1, /^[a-f0-9]{32}$/);
});

test('prompt enforces grounding and room language', () => {
  const p = buildUtterancePrompt({
    purpose: 'transition', lectureTitle: 'L', topicTitle: 'T',
    texts: ['mat'], instruction: 'do x', lang: 'ar',
  });
  assert.match(p, /Arabic/);
  assert.match(p, /do not introduce unsupported/i);
  assert.match(p, /mat/);
  assert.match(p, /Topic: T/);
});

test('purpose set is exactly the V2.2 contract', () => {
  assert.deepEqual([...UTTERANCE_PURPOSES], ['opening', 'transition', 'reexplain', 'closing_recap', 'group_recap']);
});
