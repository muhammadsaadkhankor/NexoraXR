import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  extractLectureNumber, planFromDocuments, extractChecklist,
  coverageReport, buildWriterContext,
} from './generator.mjs';
import { saveLectureLangDraft, audioApprovalGate, alignLangSegments } from './drafts.mjs';

const PROFBRAIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)),
  '../../../profbrain/lectures');

test('extractLectureNumber picks up common patterns', () => {
  assert.equal(extractLectureNumber('Lec1_Introduction.pdf'), 1);
  assert.equal(extractLectureNumber('lecture_02_haptics.pdf'), 2);
  assert.equal(extractLectureNumber('Chapter3.pdf'), 3);
  assert.equal(extractLectureNumber('04-slides.pdf'), 4);
  assert.equal(extractLectureNumber('intro.pdf'), null);
});

test('planFromDocuments: numbered files sort by number, one PDF = one lecture', () => {
  const docs = [
    { filename: 'lec2_b.pdf', documentId: 'd2', pages: 10, firstHeading: 'Beta' },
    { filename: 'lec1_a.pdf', documentId: 'd1', pages: 12, firstHeading: 'Alpha' },
  ];
  const { lectures, ambiguousOrder } = planFromDocuments(docs);
  assert.equal(ambiguousOrder, false);
  assert.equal(lectures.length, 2);
  assert.equal(lectures[0].sources[0].documentId, 'd1');
  assert.equal(lectures[0].title, 'Alpha');
  assert.equal(lectures[0].fullCoverage, true);
  assert.equal(lectures[1].sources[0].filename, 'lec2_b.pdf');
});

test('planFromDocuments: unnumbered/duplicate files flag ambiguity, keep upload order', () => {
  const { lectures, ambiguousOrder } = planFromDocuments([
    { filename: 'a.pdf', documentId: 'a', pages: 5 },
    { filename: 'lec2_b.pdf', documentId: 'b', pages: 5 },
  ]);
  assert.equal(ambiguousOrder, true);
  assert.equal(lectures[0].titleGuessed, true); // fallback filename title
});

const CHUNKS = [
  { filename: 'f.pdf', page: 1, text: '1. What is haptics? Touch science and bidirectional feedback basics.' },
  { filename: 'f.pdf', page: 1, text: '2. Perception Mechanoreceptors and thresholds for tactile stimuli.' },
  { filename: 'f.pdf', page: 2, text: '3. Teleoperation Bilateral control and stability analysis.' },
];

test('extractChecklist finds numbered topics in order', () => {
  const t = extractChecklist(CHUNKS);
  assert.deepEqual(t.map((x) => x.n), [1, 2, 3]);
  assert.match(t[0].title, /What is haptics/);
});

test('buildWriterContext: under budget returns full text + checklist', async () => {
  const { mode, checklist, context } = await buildWriterContext(CHUNKS);
  assert.equal(mode, 'full');
  assert.equal(checklist.length, 3);
  assert.ok(context.includes('bidirectional feedback')); // full text, not truncated
  assert.ok(context.includes('Teleoperation'));
});

test('coverageReport flags topics absent from the script', () => {
  const parsed = { segments: [
    { section: 'Haptics', text: 'Haptics is touch science with bidirectional feedback and tactile stimuli.' },
  ] };
  const rep = coverageReport(parsed, CHUNKS);
  assert.equal(rep.checklist.length, 3);
  assert.ok(rep.missing.some((t) => t.n === 3)); // teleoperation never narrated
});

test('saveLectureLangDraft: free-form edits realign to canonical ids', async () => {
  const lid = 'test_langdraft_x9';
  const dir = path.join(PROFBRAIN, lid);
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.writeFileSync(path.join(dir, 'segments.json'), JSON.stringify({
      title: 'T', version: 2,
      segments: [
        { id: 0, text: 'alpha one', document: 'f.pdf', page: 1, section: 'S' },
        { id: 1, text: 'beta two', document: 'f.pdf', page: 1, section: 'S' },
      ],
    }));
    const empty = await saveLectureLangDraft('cid', lid, 'ar', '   ');
    assert.equal(empty.ok, false);
    // A different segment count is allowed — texts realign to canonical ids.
    const good = await saveLectureLangDraft('cid', lid, 'ar',
      'premier paragraphe de la traduction française, assez long pour compter comme un segment complet de narration parlée avec suffisamment de mots dedans.\n\ndeuxième paragraphe traduit correspondant exactement au second segment du script canonique, également assez long pour passer le seuil minimum.\n\ntroisième paragraphe supplémentaire qui fusionne du contenu sans correspondance directe évidente dans le script canonique anglais.');
    assert.equal(good.ok, true);
    assert.ok(good.fingerprint);
    assert.ok(Array.isArray(good.uncertainIndexes));
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'translations', 'ar.json'), 'utf-8'));
    assert.equal(saved.basedOnVersion, 2);
    assert.equal(saved.edited, true);
    assert.equal(saved.segments.length, 3);
    // runtime cache mirror written (repo/src/nexora_ai/lecture_cache)
    const txt = fs.readFileSync(path.resolve(PROFBRAIN, '../../src/nexora_ai/lecture_cache/segments',
      `${lid}__ar`, 'segment_000.txt'), 'utf-8');
    assert.match(txt, /premier paragraphe/);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.rm(path.resolve(PROFBRAIN, '../../src/nexora_ai/lecture_cache/segments', `${lid}__ar`),
      { recursive: true, force: true });
  }
});

test('alignLangSegments: strong matches keep canonical ids, weak ones flag uncertain', () => {
  const canonical = [
    { id: 0, text: 'Haptics is the science of touch feedback and force rendering in devices.' },
    { id: 1, text: 'Teleoperation lets an operator control a remote robot bilaterally.' },
  ];
  const out = alignLangSegments([
    'haptics science touch feedback force rendering devices explained',
    'completely unrelated sentence about something else entirely novel',
  ], canonical);
  assert.equal(out[0].id, 0);
  assert.equal(out[0].mapped, 'kept');
  assert.equal(out[1].mapped, 'uncertain');
});

test('audioApprovalGate: blocks outdated translations; uncertain mappings warn only', () => {
  const drafts = { L1: { version: 2, segments: [{ mapped: 'kept' }, { mapped: 'uncertain' }] } };
  const langDocs = { L1: { ar: { basedOnVersion: 2 }, fr: { basedOnVersion: 1 } } };
  // stale fr → blocked; uncertain en segment → warning, NOT a block
  const g = audioApprovalGate(drafts, langDocs, ['en', 'ar', 'fr']);
  assert.equal(g.ok, false);
  assert.ok(g.blocked.some((b) => b.includes('outdated')));
  assert.ok(g.warnings.some((w) => w.includes('uncertain') || w.includes('fallback')));
  // only stale fr blocks
  assert.equal(g.blocked.length, 1);
  assert.match(g.blocked[0], /outdated/);
  // all current → clean, warnings still reported
  const g3 = audioApprovalGate(drafts, { L1: { ar: { basedOnVersion: 2 }, fr: { basedOnVersion: 2 } } },
    ['en', 'ar', 'fr'], { confirmUncertain: true });
  assert.equal(g3.ok, true);
  assert.equal(g3.warnings.length, 1);
});

test('planFromDocuments: synthetic "Page N" headings are never lecture titles', () => {
  const docs = [
    { filename: 'Lec1_Introduction.pdf', documentId: 'd1', pages: 30, firstHeading: 'Page 1' },
    { filename: 'Lec2_Linear_Regression.pdf', documentId: 'd2', pages: 56, firstHeading: 'Page 1' },
  ];
  const { lectures } = planFromDocuments(docs);
  assert.equal(lectures.length, 2);
  assert.ok(!/^page\s*\d+/i.test(lectures[0].title), `bad title: ${lectures[0].title}`);
  assert.ok(!/^page\s*\d+/i.test(lectures[1].title), `bad title: ${lectures[1].title}`);
  assert.equal(lectures[0].idx, 1);
  assert.equal(lectures[1].idx, 2);
});

test('planFromDocuments: stem beats stale metadata; shared metadata titles never collide', () => {
  const docs = [
    { filename: 'Lec1_Introduction.pdf', documentId: 'd1', pages: 30,
      title: 'Introduction to Telecommunications', firstHeading: 'Page 1' },
    { filename: 'Lec2_Linear_Regression.pdf', documentId: 'd2', pages: 56,
      title: 'Introduction to Telecommunications', firstHeading: 'Page 1' },
  ];
  const { lectures } = planFromDocuments(docs);
  assert.equal(lectures[0].title, 'Lecture 1: Introduction');
  assert.equal(lectures[1].title, 'Lecture 2: Linear Regression');
  assert.notEqual(lectures[0].title, lectures[1].title);
});

test('planFromDocuments: real metadata title still used when nothing better exists', () => {
  const docs = [
    { filename: 'slides.pdf', documentId: 'd1', pages: 10,
      title: 'Introduction to Machine Learning', firstHeading: 'Page 1' },
  ];
  const { lectures } = planFromDocuments(docs);
  assert.equal(lectures[0].title, 'Introduction to Machine Learning');
});

test('planFromDocuments: filename stem becomes "Lecture N: Name" fallback', () => {
  const docs = [
    { filename: 'lec2_linear_regression.pdf', documentId: 'd2', pages: 56, firstHeading: 'Page 1' },
  ];
  const { lectures } = planFromDocuments(docs);
  assert.match(lectures[0].title, /^Lecture 2: Linear regression/);
});

test('planFromDocuments: two PDFs → two ordered lectures', () => {
  const docs = [
    { filename: 'Lec1_Introduction.pdf', documentId: 'd1', pages: 30, firstHeading: 'Page 1' },
    { filename: 'Lec2_Linear_Regression.pdf', documentId: 'd2', pages: 56, firstHeading: 'Page 1' },
  ];
  const { lectures, ambiguousOrder } = planFromDocuments(docs);
  assert.equal(ambiguousOrder, false);
  assert.deepEqual(lectures.map((l) => l.idx), [1, 2]);
});
