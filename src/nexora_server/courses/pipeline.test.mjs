import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSections, chunkSection } from './pipeline.mjs';
import { parseScript } from './generator.mjs';
import { cosine } from './llm.mjs';

test('parseSections detects heading-style section breaks', () => {
  const pages = [
    'CHAPTER 1 INTRODUCTION\n' + 'intro text '.repeat(60),
    'body text '.repeat(30) + '\nLINEAR REGRESSION\n' + 'regression text '.repeat(60),
  ];
  const secs = parseSections(pages);
  assert.ok(secs.length >= 1);
  assert.ok(secs.every((s) => s.pageStart >= 1 && s.pageEnd >= s.pageStart));
});

test('chunkSection produces word-bounded chunks with provenance', () => {
  const sec = { title: 'X', pageStart: 3, text: Array.from({ length: 2000 }, (_, i) => `w${i}`).join(' ') };
  const chunks = chunkSection(sec, 0);
  assert.ok(chunks.length >= 3);
  for (const c of chunks) {
    assert.ok(c.text.split(/\s+/).length <= 700);
    assert.equal(c.page, 3);
    assert.equal(c.heading, 'X');
  }
});

test('parseScript: titled sections with paragraphs', () => {
  const raw = 'TITLE: Intro to Python\nSECTION: Welcome\nWelcome everyone today we begin.\n\nThis is overview.\nSECTION: Basics\nVariables and types explained.';
  const s = parseScript(raw);
  assert.equal(s.title, 'Intro to Python');
  assert.equal(s.sections.length, 2);
  assert.equal(s.sections[0].paragraphs.length, 2);
});

test('parseScript tolerates markdown headings', () => {
  const s = parseScript('# Lecture: X\n## Setup\ncontent here for you\n## Recap\nmore content here');
  assert.equal(s.sections.length, 2);
});

test('cosine similarity on unit vectors', () => {
  assert.ok(Math.abs(cosine([1, 0, 0], [1, 0, 0]) - 1) < 1e-9);
  assert.ok(Math.abs(cosine([1, 0], [0, 1])) < 1e-9);
});

import { parseSegments, segsToSections, validateLecture, resolvePlanSources } from './generator.mjs';

const WORDS = (n) => Array.from({ length: n }, (_, i) => 'word' + (i % 9)).join(' ');

test('parseSegments: JSON output with provenance', () => {
  const raw = JSON.stringify({
    title: 'Linear Regression',
    segments: [
      { section: 'Intro', document: 'lec2.pdf', page: 3, text: WORDS(60) },
      { section: 'Intro', document: 'lec2.pdf', page: 4, text: WORDS(70) },
      { section: 'Math', document: 'lec1.pdf', page: 1, text: WORDS(50) },
    ],
  });
  const p = parseSegments(raw);
  assert.equal(p.title, 'Linear Regression');
  assert.equal(p.segments.length, 3);
  assert.equal(p.segments[0].document, 'lec2.pdf');
  assert.equal(p.sections.length, 2);
});

test('validateLecture: enforces assigned documents and page ranges', () => {
  const allowedDocs = {
    'a.pdf': { documentId: 'd1', pages: [[2, 5]] },
    'b.pdf': { documentId: 'd2', pages: [[10, 20]] },
  };
  const mk = (segs) => ({ title: 'T', segments: segs, sections: segsToSections(segs) });
  const good = mk([0, 1, 2, 3].map((i) => ({
    section: 'S', document: 'a.pdf', page: 3, text: WORDS(100),
  })));
  const g = validateLecture(good, allowedDocs);
  assert.equal(g.ok, true, g.problems.join(', '));
  // wrong document
  const bad = mk([0, 1, 2, 3].map((i) => ({
    section: 'S', document: i === 2 ? 'other.pdf' : 'a.pdf', page: 3, text: WORDS(100),
  })));
  assert.equal(validateLecture(bad, allowedDocs).ok, false);
  // page outside assigned range
  const off = mk([0, 1, 2, 3].map((i) => ({
    section: 'S', document: 'a.pdf', page: i === 1 ? 9 : 3, text: WORDS(100),
  })));
  assert.equal(validateLecture(off, allowedDocs).ok, false);
});

test('resolvePlanSources: maps LLM source names to documentIds + merged pages', () => {
  const inv = [
    { filename: 'lec1.pdf', documentId: 'd1', title: 'Intro', page_start: 2, page_end: 6 },
    { filename: 'lec1.pdf', documentId: 'd1', title: 'Grading', page_start: 7, page_end: 8 },
    { filename: 'lec2.pdf', documentId: 'd2', title: 'Regression', page_start: 1, page_end: 12 },
    { filename: 'lec2.pdf', documentId: 'd2', title: 'Optimization', page_start: 13, page_end: 20 },
  ];
  const out = resolvePlanSources([
    { title: 'L1', sources: [{ document: 'lec1.pdf', sections: ['Intro'] }] },
    { title: 'L2', sources: [{ document: 'lec2.pdf', sections: ['Regression', 'Optimization'] }] },
  ], inv);
  assert.equal(out.length, 2);
  assert.equal(out[0].sources[0].documentId, 'd1');
  assert.deepEqual(out[0].sources[0].pages, [[2, 6]]);
  assert.deepEqual(out[1].sources[0].pages, [[1, 20]]);
  // hallucinated section → dropped, no sources
  const ghost = resolvePlanSources([{ title: 'G', sources: [{ document: 'lec1.pdf', sections: ['Nope'] }] }], inv);
  assert.equal(ghost[0].sources.length, 0);
});

// ---------- OCR fallback ----------
import { fillMissingText } from './pipeline.mjs';

const words = (n, w = 'text') => Array(n).fill(w).join(' ');

test('fillMissingText keeps text-layer pages, OCRs only image-only pages', async () => {
  const seen = [];
  const ocrFn = async (path, pages) => { seen.push(...pages); return new Map([[2, 'OCR page two text'], [3, 'OCR page three']]); };
  const { texts, ocrPages } = await fillMissingText('x.pdf', [words(40), '', ''], ocrFn);
  assert.deepEqual(seen, [2, 3], 'only sparse pages OCRed');
  assert.equal(texts[0], words(40));
  assert.equal(texts[1], 'OCR page two text');
  assert.equal(ocrPages, 2);
});

test('normal text PDFs trigger zero OCR calls', async () => {
  let called = 0;
  const { texts, ocrPages } = await fillMissingText('x.pdf', [words(50), words(60)], async () => { called++; return new Map(); });
  assert.equal(called, 0);
  assert.equal(ocrPages, 0);
});

test('OCR that returns nothing leaves the original (sparse) text', async () => {
  const { texts, ocrFailed } = await fillMissingText('x.pdf', ['', ''], async () => new Map());
  assert.equal(texts[0], '');
  assert.equal(ocrFailed, 2);
});

test('image-only doc with OCR still feeds parseSections → chunks', async () => {
  const ocrFn = async () => new Map([[1, 'Ubiquitous sensing uses Bayesian inference and sensor fusion'], [2, 'Noise models characterize measurement uncertainty']]);
  const { texts } = await fillMissingText('x.pdf', ['', ''], ocrFn);
  const sections = parseSections(texts);
  const chunks = sections.flatMap((s) => chunkSection(s, 0));
  assert.ok(chunks.length >= 2);
  assert.equal(chunks[0].page, 1);
});
