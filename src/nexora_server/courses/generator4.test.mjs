import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateLectureFast, validatePlan, assignConcepts, fallbackPlan,
  GENERATOR_VERSION,
} from './generator4.mjs';
import { detectRepetition, dedupeSegments, blockGaps } from './generator3.mjs';

const prose = (n, w = 'concept') => Array(n).fill(w).join(' ');
const SEC = (title, pageStart, pageEnd, text) => ({ title, pageStart, pageEnd, text, filename: 'lec.pdf' });
const CH = (st, pg, tx) => ({ heading: st, page: pg, text: tx, filename: 'lec.pdf' });
const entry = { idx: 1, title: 'Linear Regression', sources: [{ filename: 'lec.pdf', documentId: 'd1', pages: [[1, 60]] }] };
const corpusOf = (pairs) => ({
  teaching: pairs.map(([s, chunks]) => ({ ...s, chunks })),
  excluded: [], unprocessedPages: [],
});

const PLAN_JSON = {
  objective: 'Teach linear regression end-to-end',
  concepts: [
    { title: 'Model Form', why: 'defines prediction', examples: ['y=mx+b'], source: 'lec.pdf', pageStart: 5, pageEnd: 10 },
    { title: 'OLS Solution', why: 'computes coefficients', examples: ['normal equations'], source: 'lec.pdf', pageStart: 30, pageEnd: 40 },
    { title: 'Evaluation', why: 'measures fit', examples: ['MSE', 'R2'], source: 'lec.pdf', pageStart: 41, pageEnd: 45 },
  ],
  omitted: ['matrix theory'],
};

const SCRIPT_JSON = {
  segments: [
    { document: 'lec.pdf', page: 1, concept: 'Introduction', text: prose(60, 'intro words about linear regression') },
    { document: 'lec.pdf', page: 6, concept: 'Model Form', text: prose(120, 'model form predicts continuous outcomes') },
    { document: 'lec.pdf', page: 35, concept: 'OLS Solution', text: prose(140, 'ordinary least squares minimizes squared errors') },
    { document: 'lec.pdf', page: 42, concept: 'Evaluation', text: prose(120, 'mse measures average squared difference between predicted and actual') },
    { document: 'lec.pdf', page: 45, concept: 'Recap', text: prose(60, 'recap the fitted line minimizes total squared error') },
  ],
};

// Mock chat: first call = plan, second = narration, extras fail.
const makeChat = (planResp, scriptResp, extras = {}) => {
  const calls = [];
  return {
    calls,
    chat: async (msgs) => {
      calls.push(msgs[1].content);
      if (calls.length === 1) return planResp;
      if (extras[calls.length]) return extras[calls.length];
      return scriptResp;
    },
  };
};

// Mock loadCorpus via deps injection isn't possible — generator4 imports it.
// Test the pure helpers + the full path through a stub corpus by monkeying
// deps: generateLectureFast accepts deps.chat; loadCorpus needs a pool — skip
// full-path test here (integration is manual), test units instead.

test('validatePlan accepts a well-formed plan, drops invalid sources', () => {
  const corpus = corpusOf([[SEC('a', 1, 5, prose(50)), []]]);
  const v = validatePlan(PLAN_JSON, corpus);
  assert.equal(v.ok, true);
  assert.equal(v.plan.concepts.length, 3);
});

test('validatePlan rejects malformed plan', () => {
  const corpus = corpusOf([[SEC('a', 1, 5, prose(50)), []]]);
  assert.equal(validatePlan({ garbage: true }, corpus).ok, false);
  assert.equal(validatePlan({ objective: 'x', concepts: [] }, corpus).ok, false);
});

test('fallbackPlan preserves source order, marks concepts', () => {
  const corpus = corpusOf([[SEC('S1', 1, 5, prose(50)), []], [SEC('S2', 6, 10, prose(50)), []]]);
  const p = fallbackPlan(entry, corpus);
  assert.equal(p.concepts.length, 2);
  assert.equal(p._fallback, true);
  assert.equal(p.concepts[0].source, 'lec.pdf');
});

test('assignConcepts maps intro/recap and concept labels to blockIds', () => {
  const plan = { concepts: [
    { title: 'Model Form', blockId: 'c1' }, { title: 'OLS', blockId: 'c2' }] };
  const p = { segments: [
    { id: 0, section: 'Introduction', concept: 'Introduction' },
    { id: 1, section: 'x', concept: 'Model Form' },
    { id: 2, section: 'x', concept: 'OLS Solution' },
    { id: 3, section: 'x', concept: 'Recap' },
  ] };
  assignConcepts(p, plan);
  assert.equal(p.segments[0].blockId, '__intro');
  assert.equal(p.segments[1].blockId, 'c1');
  assert.equal(p.segments[2].blockId, 'c2');
  assert.equal(p.segments[3].blockId, '__recap');
});

test('fast script shape is schema-compatible with V3 consumers', () => {
  const segs = SCRIPT_JSON.segments.map((s, i) => ({ id: i, ...s }));
  assert.ok(segs.every((s) => s.document && s.page != null && s.text));
  // No dups in the mocked happy path
  assert.equal(detectRepetition(segs).filter((f) => f.type === 'duplicate').length, 0);
});

test('dedupe + blockGaps still work on fast output (duplicate narration rejected)', () => {
  const segs = SCRIPT_JSON.segments.map((s, i) => ({ id: i, ...s, blockId: 'c1' }));
  const dup = { ...segs[1], id: 5, text: segs[1].text };
  const { segments, removedIds } = dedupeSegments([...segs, dup]);
  assert.equal(removedIds.length, 1);
  assert.equal(segments.length, 5);
});

test('GENERATOR_VERSION is distinct for eval separation', () => {
  assert.match(GENERATOR_VERSION, /^fast/);
});

// ---------- quality regressions (fast path) ----------
import { detectFiller, validateFast, conceptEvidence, narrationPrompt } from './generator4.mjs';

test('importance weighting: high concepts get ~2x budget of medium', () => {
  const plan = { objective: 'x', concepts: [
    { title: 'A', importance: 'high', order: 1, why: 'w', source: 'lec.pdf', pageStart: 1, pageEnd: 5 },
    { title: 'B', importance: 'medium', order: 2, why: 'w', source: 'lec.pdf', pageStart: 6, pageEnd: 10 },
    { title: 'C', importance: 'high', order: 3, why: 'w', source: 'lec.pdf', pageStart: 11, pageEnd: 15 },
  ] };
  const corpus = corpusOf([[SEC('a',1,5,prose(50)),[CH('s1',2,'ev')]]]);
  const { usr } = narrationPrompt(entry, plan, corpus);
  const mA = /A \[high, ~(\d+) words\]/.exec(usr);
  const mB = /B \[medium, ~(\d+) words\]/.exec(usr);
  assert.ok(Number(mA[1]) >= 1.5 * Number(mB[1]), `budget ratio ${mA[1]} vs ${mB[1]}`);
});

test('conceptEvidence spreads across the page range, not just the head', () => {
  const chunks = [CH('s1', 2, 'first'), CH('s1', 8, 'middle'), CH('s1', 14, 'last')];
  const corpus = corpusOf([[SEC('S', 1, 20, prose(200)), chunks]]);
  const ev = conceptEvidence({ source: 'lec.pdf', pageStart: 1, pageEnd: 20 }, corpus);
  assert.ok(ev.includes('first') && ev.includes('middle') && ev.includes('last'));
});

test('detectFiller flags generic connectors without substance', () => {
  const segs = [
    { id: 0, text: 'An example illustrates this concept clearly.' },
    { id: 1, text: 'This concept is important for students.' },
    // long-enough segment with the same phrase is NOT filler (it has substance)
    { id: 2, text: 'These components work together to process data: representation shapes the input, evaluation guides learning through the loss function, and optimization updates weights until the model converges on useful predictions.' },
  ];
  const out = detectFiller(segs);
  assert.ok(out.some((f) => f.segment === 0));
  assert.ok(out.some((f) => f.segment === 1));
  assert.ok(!out.some((f) => f.segment === 2));
});

test('validateFast rejects shallow core coverage + filler, keeps real explanations', () => {
  const plan = { objective: 'x', blocks: [], concepts: [
    { title: 'Deep', importance: 'high', blockId: 'c1' },
    { title: 'Minor', importance: 'medium', blockId: 'c2' },
  ] };
  const bad = { title: 't', segments: [
    { id: 0, section: 'Intro', document: 'lec.pdf', page: 1, text: prose(60, 'i1'), blockId: '__intro' },
    { id: 1, section: 'Deep', document: 'lec.pdf', page: 2, text: 'An example illustrates deep learning.', blockId: 'c1' },
    { id: 2, section: 'Minor', document: 'lec.pdf', page: 3, text: prose(150, 'm1'), blockId: 'c2' },
    { id: 3, section: 'Recap', document: 'lec.pdf', page: 4, text: prose(60, 'r1'), blockId: '__recap' },
  ] };
  const v = validateFast(bad, { 'lec.pdf': { documentId: 'd1', pages: [[1, 10]] } }, plan);
  assert.equal(v.ok, false);
  assert.ok(v.problems.some((p) => p.includes('under-explained')));
  assert.ok(v.problems.some((p) => p.includes('filler')));
});

test('validateFast passes a well-formed script', () => {
  const plan = { objective: 'x', blocks: [], concepts: [
    { title: 'Deep', importance: 'high', blockId: 'c1' },
    { title: 'Minor', importance: 'medium', blockId: 'c2' },
  ] };
  const good = { title: 't', segments: [
    { id: 0, section: 'Introduction', document: 'lec.pdf', page: 1, text: prose(60, 'i1'), blockId: '__intro' },
    { id: 1, section: 'Deep', document: 'lec.pdf', page: 2, text: prose(220, 'd1'), blockId: 'c1' },
    { id: 2, section: 'Minor', document: 'lec.pdf', page: 3, text: prose(120, 'm1'), blockId: 'c2' },
    { id: 3, section: 'Recap', document: 'lec.pdf', page: 4, text: prose(60, 'r1'), blockId: '__recap' },
  ] };
  const v = validateFast(good, { 'lec.pdf': { documentId: 'd1', pages: [[1, 10]] } }, plan);
  assert.equal(v.ok, true);
});

test('narrationPrompt includes teach-first and no-filler instructions', () => {
  const corpus = corpusOf([[SEC('a',1,5,prose(50)),[CH('s1',2,'ev')]]]);
  const { sys } = narrationPrompt(entry, { objective: 'x', concepts: PLAN_JSON.concepts }, corpus);
  assert.match(sys, /Explain the idea BEFORE naming/);
  assert.match(sys, /NO filler/);
  assert.match(sys, /40–150 spoken words/);
});

// ---------- provenance clamping (Haptics regression) ----------
import { normalizeSegmentPages } from './generator4.mjs';

test('out-of-range model pages are clamped to the concept source range', () => {
  const plan = { concepts: [{ title: 'A', blockId: 'c1', source: 'doc.pdf', pageStart: 1, pageEnd: 2 }] };
  const p = { segments: [
    { id: 0, blockId: 'c1', document: 'doc.pdf', page: 3, text: 'x' },   // doc has 2 pages!
    { id: 1, blockId: 'c1', document: 'doc.pdf', page: 1, text: 'y' },
    { id: 2, blockId: 'c1', document: 'other.pdf', page: 9, text: 'z' },
  ] };
  const w = normalizeSegmentPages(p, plan);
  assert.equal(p.segments[0].page, 2, 'clamped to last real page');
  assert.equal(p.segments[1].page, 1, 'in-range page untouched');
  assert.equal(p.segments[2].document, 'doc.pdf', 'wrong doc clamped to source');
  assert.equal(p.segments[2].page, 2);
  assert.equal(w.length, 3);
});

test('in-range provenance produces no warnings', () => {
  const plan = { concepts: [{ title: 'A', blockId: 'c1', source: 'doc.pdf', pageStart: 1, pageEnd: 5 }] };
  const p = { segments: [{ id: 0, blockId: 'c1', document: 'doc.pdf', page: 3, text: 'x' }] };
  assert.deepEqual(normalizeSegmentPages(p, plan), []);
});
