import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyDraftEdits, scriptFingerprint, splitScriptIntoSegments,
         alignSegments, validateDraftScript } from './drafts.mjs';

const SEGJSON = {
  lectureId: 'gen_x_L1',
  title: 'T',
  segments: [
    { id: 0, section: 'Intro', document: 'a.pdf', documentId: 'd1', page: 3, text: 'first words' },
    { id: 1, section: 'Body', document: 'a.pdf', documentId: 'd1', page: 7, text: 'second words' },
  ],
};

test('applyDraftEdits preserves ids and page mappings, edits only text', () => {
  const edits = [
    { index: 0, text: 'first words edited' },
    { index: 1, text: 'second words' },
  ];
  const r = applyDraftEdits(SEGJSON, edits);
  assert.equal(r.ok, true);
  assert.deepEqual(r.changedIndexes, [0]);
  assert.equal(r.segments[0].text, 'first words edited');
  // provenance untouched
  assert.equal(r.segments[0].id, 0);
  assert.equal(r.segments[0].page, 3);
  assert.equal(r.segments[0].document, 'a.pdf');
  assert.equal(r.segments[1].text, 'second words');
});

test('applyDraftEdits rejects missing/extra/empty edits', () => {
  assert.equal(applyDraftEdits(SEGJSON, [{ index: 0, text: 'x' }]).ok, false);
  assert.equal(applyDraftEdits(SEGJSON, null).ok, false);
  // Empty text anywhere fails the whole save.
  assert.throws(() => applyDraftEdits(SEGJSON, [
    { index: 0, text: 'ok' }, { index: 1, text: '   ' },
  ]));
});

test('splitScriptIntoSegments: paragraphs -> segments; tiny merge; long split', () => {
  const longPara = Array.from({ length: 12 }, (_, i) =>
    `Sentence number ${i} carries enough words to count as real narration content here.`).join(' ');
  const script = `Welcome to the lecture today we begin the course.\n\nShort.\n\n${longPara}`;
  const segs = splitScriptIntoSegments(script);
  assert.ok(segs.length >= 2);
  assert.ok(segs.every((s) => s.length > 0));
  // A micro paragraph merges forward instead of becoming its own segment.
  assert.ok(!segs.some((s) => s === 'Short.'));
});

test('alignSegments: kept on similar text, auto on chunk match, uncertain on no match', () => {
  const oldSegs = [
    { id: 0, section: 'Intro', document: 'a.pdf', documentId: 'd1', page: 3,
      text: 'linear regression fits a line minimizing squared error between predictions and observations' },
    { id: 1, section: 'Recap', document: 'a.pdf', documentId: 'd1', page: 9,
      text: 'recap of the whole chapter' },
  ];
  const chunks = [
    { text: 'gradient descent iterates parameters downhill along the loss surface until convergence', page: 14,
      heading: 'Optimization', filename: 'b.pdf', document_id: 'd2' },
  ];
  const texts = [
    // near-copy of old seg 0 -> keeps its mapping
    'Linear regression fits a line minimizing squared error between predictions and observations carefully.',
    // matches the chunk -> remapped to its page
    'We use gradient descent to iterate parameters downhill along the loss surface until convergence is reached.',
    // nothing matches -> inherits previous position, flagged uncertain
    'totally unrelated tangential remarks about something else entirely',
  ];
  const r = alignSegments(texts, oldSegs, chunks);
  assert.equal(r[0].mapped, 'kept');
  assert.equal(r[0].page, 3);
  assert.equal(r[0].documentId, 'd1');
  assert.equal(r[1].mapped, 'auto');
  assert.equal(r[1].page, 14);
  assert.equal(r[1].documentId, 'd2');
  assert.equal(r[2].mapped, 'uncertain');
  assert.equal(r[2].page, 14);           // inherited previous position
});

test('validateDraftScript flags empty/oversized scripts', () => {
  assert.equal(validateDraftScript([{ text: 'word '.repeat(200) }]).ok, true);
  assert.equal(validateDraftScript([]).ok, false);
  assert.equal(validateDraftScript([{ text: 'tiny' }]).ok, false);
  assert.equal(validateDraftScript([{ text: 'w '.repeat(2000) }]).ok, false);
});

test('scriptFingerprint changes when any segment text changes', () => {
  const a = scriptFingerprint(SEGJSON.segments);
  const edited = SEGJSON.segments.map((s, i) => i === 0 ? { ...s, text: 'changed' } : s);
  assert.notEqual(scriptFingerprint(edited), a);
  // Stable for identical input.
  assert.equal(scriptFingerprint(SEGJSON.segments), a);
});

// ---------- audio gate: uncertain alignment is non-blocking ----------
import { audioApprovalGate } from './drafts.mjs';

const seg = (mapped) => ({ mapped });

test('uncertain page mappings warn but never block audio', () => {
  const r = audioApprovalGate(
    { L1: { version: 2, segments: [seg('kept'), seg('uncertain'), seg('uncertain')] } },
    {}, ['en']);
  assert.equal(r.ok, true);
  assert.deepEqual(r.blocked, []);
  assert.equal(r.warnings.length, 1);
});

test('missing canonical script still blocks', () => {
  const r = audioApprovalGate({ L1: null }, {}, ['en']);
  assert.equal(r.ok, false);
  assert.ok(r.blocked[0].includes('missing canonical'));
});

test('stale translation version blocks; current one passes', () => {
  const en = { L1: { version: 3, segments: [seg('kept')] } };
  const r1 = audioApprovalGate(en, { L1: { ar: { basedOnVersion: 2, uncertainIndexes: [] } } }, ['en', 'ar']);
  assert.equal(r1.ok, false);
  assert.ok(r1.blocked[0].includes('outdated'));
  const r2 = audioApprovalGate(en, { L1: { ar: { basedOnVersion: 3, uncertainIndexes: [0] } } }, ['en', 'ar']);
  assert.equal(r2.ok, true);
  assert.equal(r2.warnings.length, 1);
});

test('missing language script blocks only for selected languages', () => {
  const en = { L1: { version: 1, segments: [seg('kept')] } };
  assert.equal(audioApprovalGate(en, {}, ['en', 'fr']).ok, false);
  assert.equal(audioApprovalGate(en, {}, ['en']).ok, true);
});
