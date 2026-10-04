// NCIP resume-resolution tests — run: node --test src/services/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveResume, validateCheckpoint, lectureSegmentIndex } from './ncipResume.js';

const seg = (lec, i, resumeAt) => ({ id: `${lec}_seg_${i}`, type: 'lecture', resumeAt });
const answer = (id = 'a1') => ({ id, type: 'answer', floorAnswer: true });
const CP = { lectureId: 'Lecture_1', segmentIndex: 2, playbackOffsetMs: 4500, language: 'en' };

test('resume plan: head is the checkpoint segment -> seek-head at server offset', () => {
  const msgs = [seg('Lecture_1', 2, 1.2), seg('Lecture_1', 3)];
  const plan = resolveResume(msgs, CP);
  assert.equal(plan.action, 'seek-head');
  assert.equal(plan.messageId, 'Lecture_1_seg_2');
  assert.equal(plan.offsetSec, 4.5);
});

test('two clients with different local resumeAt get the same server target', () => {
  const a = resolveResume([seg('Lecture_1', 2, 0.5), seg('Lecture_1', 3)], CP);
  const b = resolveResume([seg('Lecture_1', 2, 9.9), seg('Lecture_1', 3)], CP);
  assert.equal(a.offsetSec, b.offsetSec);
  assert.equal(a.messageId, b.messageId);
});

test('client behind by whole segments -> trim-and-seek to checkpoint segment', () => {
  const msgs = [seg('Lecture_1', 0), seg('Lecture_1', 1), seg('Lecture_1', 2), seg('Lecture_1', 3)];
  const plan = resolveResume(msgs, CP);
  assert.equal(plan.action, 'trim-and-seek');
  assert.equal(plan.fromIndex, 2);
  assert.equal(plan.offsetSec, 4.5);
});

test('answer still at head -> trim-and-seek to checkpoint segment under it', () => {
  const msgs = [answer(), seg('Lecture_1', 2, 3.0), seg('Lecture_1', 3)];
  const plan = resolveResume(msgs, CP);
  assert.equal(plan.action, 'trim-and-seek');
  assert.equal(plan.fromIndex, 1);
});

test('offset 0 is honored (legitimate segment-start resume)', () => {
  const msgs = [seg('Lecture_1', 2, 7.7)];
  const plan = resolveResume(msgs, { ...CP, playbackOffsetMs: 0 });
  assert.equal(plan.action, 'seek-head');
  assert.equal(plan.offsetSec, 0);
});

test('invalid checkpoints -> local-fallback, never a silent restart', () => {
  const msgs = [seg('Lecture_1', 2, 3.3)];
  for (const bad of [
    { segmentIndex: 2, playbackOffsetMs: 4500 },                 // no lectureId
    { lectureId: 'Lecture_1', segmentIndex: -1, playbackOffsetMs: 0 },
    { lectureId: 'Lecture_1', segmentIndex: 2, playbackOffsetMs: -5 },
    { lectureId: 'Lecture_1', segmentIndex: 'x', playbackOffsetMs: 10 },
    'garbage', 42,
  ]) {
    const plan = resolveResume(msgs, bad);
    assert.equal(plan.action, 'local-fallback', JSON.stringify(bad));
    assert.equal(plan.reason, 'invalid-checkpoint');
  }
});

test('unmappable checkpoint (client ahead) -> local-fallback, no restart', () => {
  const msgs = [seg('Lecture_1', 5, 1.0), seg('Lecture_1', 6)]; // already past seg 2
  const plan = resolveResume(msgs, CP);
  assert.equal(plan.action, 'local-fallback');
  assert.equal(plan.reason, 'checkpoint-unmapped');
  assert.equal(plan.headId, 'Lecture_1_seg_5');
});

test('different lectureId in checkpoint -> local-fallback', () => {
  const msgs = [seg('Lecture_1', 2, 3.0)];
  const plan = resolveResume(msgs, { ...CP, lectureId: 'Lecture_9' });
  assert.equal(plan.action, 'local-fallback');
  assert.equal(plan.reason, 'checkpoint-unmapped');
});

test('no checkpoint -> plain local fallback (legacy resumeAt path)', () => {
  const plan = resolveResume([seg('Lecture_1', 2, 3.0)], undefined);
  assert.equal(plan.action, 'local-fallback');
  assert.equal(plan.reason, null);
});

test('no lecture message at all -> abort', () => {
  const plan = resolveResume([answer()], CP);
  assert.equal(plan.action, 'abort');
  assert.equal(plan.reason, 'no-lecture-message');
});

test('empty queue -> abort', () => {
  const plan = resolveResume([], CP);
  assert.equal(plan.action, 'abort');
});

test('validateCheckpoint normalizes valid payloads', () => {
  assert.deepEqual(validateCheckpoint(CP), CP);
  assert.equal(validateCheckpoint({ ...CP, language: undefined }).language, null);
});

test('lectureSegmentIndex parses message ids', () => {
  assert.equal(lectureSegmentIndex('Lecture_1_seg_12'), 12);
  assert.equal(lectureSegmentIndex('noseg'), null);
});
