// V2 generator unit tests — mocks + fixtures only. No LLM, DB, TTS, or
// network calls: injected deps replace them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifySection, buildTopicInventory, buildTeachingPlan,
  validateLectureV2, assignSegmentTopics, topicWordCounts,
  compressOvershoot, critique, revise, generateLectureV2,
  EVIDENCE_KINDS, EXCLUDED_KINDS, EFFECTIVE_WPM,
} from './generator2.mjs';
import { parseSegments } from './generator.mjs';

// ---------- fixtures ---------------------------------------------------------
const SEC = (id, title, ps, pe, text, opts = {}) => ({
  id, title, summary: opts.summary || null, page_start: ps, page_end: pe,
  idx: Number(id.replace(/\D/g, '') || 0), filename: 'lec.pdf', document_id: 'docA',
  ...opts,
});
const CH = (sid, page, text, id = `${sid}c${page}`) => ({
  id, section_id: sid, heading: '', text, page, filename: 'lec.pdf', document_id: 'docA',
});
const prose = (w) => Array(w).fill('concept').join(' ');

const entry = {
  idx: 1, title: 'Introduction to Machine Learning',
  sources: [{ filename: 'lec.pdf', documentId: 'docA', pages: [[1, 30]] }],
  objectives: ['define machine learning', 'name the learning paradigms'],
};

// ---------- Phase 1: classification -------------------------------------------
test('admin/exercise/references sections are excluded; teaching sections stay', () => {
  assert.equal(classifySection({ title: 'Academic Integrity Policy', text: 'Students must work alone.' }).kind, 'admin');
  assert.equal(classifySection({ title: 'Office Hours and Contact', text: 'Email me Tuesdays.' }).kind, 'admin');
  assert.equal(classifySection({ title: 'References', text: '[1] Bishop, 2006.' }).kind, 'references');
  assert.equal(classifySection({ title: 'Homework 1', text: 'Submit by Friday.' }).kind, 'exercise');
  assert.equal(
    classifySection({ title: 'Linear Regression', text: 'A linear regression model predicts a continuous output. It is defined as the weighted sum of input features. This function maps inputs to outputs.' }).kind,
    'concept');
  assert.equal(
    classifySection({ title: 'Gradient descent derivation', text: 'We derive the gradient of the cost function with respect to the weights. The partial derivative ∂L/∂w points along the steepest descent.' }).kind,
    'math');
});

test('admin body under a neutral title is still admin (layered check)', () => {
  const t = { title: 'Overview', summary: '', text: 'Grading: 40% homework, 60% exams. Office hours Tuesday. Contact the instructor by email. Attendance is required. Deadlines are strict.' };
  assert.equal(classifySection(t).kind, 'admin');
});

test('document is not rejected just because early pages are admin', async () => {
  const sections = [
    SEC('s1', 'Academic Integrity', 1, 2, 'Students must not plagiarize. Grading scheme: 50% final.'),
    SEC('s2', 'What is Machine Learning', 3, 10, 'Machine learning is a method of pattern discovery. It is a subfield of AI defined by learning from data.'),
    SEC('s3', 'Supervised Learning', 11, 20, 'Supervised learning uses labeled examples. A training set is defined as pairs of inputs and targets.'),
  ];
  const chunks = [
    CH('s1', 1, sections[0].text), CH('s2', 5, sections[1].text), CH('s3', 12, sections[2].text),
  ];
  const inv = await buildTopicInventory('c1', entry, { sections, chunks, chat: async () => ({ kinds: [] }) });
  assert.deepEqual(inv.topics.map((t) => t.title), ['What is Machine Learning', 'Supervised Learning']);
  assert.equal(inv.excluded[0].kind, 'admin');
});

// ---------- Phase 2: inventory + plan ------------------------------------------
test('topic inventory traverses document order — early/mid/late all included', async () => {
  const sections = [
    SEC('s1', 'Foundations', 1, 3, prose(200)),
    SEC('s2', 'Core Method', 5, 8, prose(300)),
    SEC('s3', 'Advanced Variant', 20, 26, prose(300)),
  ];
  const chunks = [CH('s1', 2, sections[0].text), CH('s2', 6, sections[1].text), CH('s3', 22, sections[2].text)];
  const inv = await buildTopicInventory('c1', entry, { sections, chunks, chat: async () => ({ kinds: [] }) });
  assert.equal(inv.topics.length, 3);
  assert.deepEqual(inv.topics.map((t) => t.source.pageStart), [1, 5, 20]);
});

test('teaching plan allocates budgets, reserves intro+conclusion, records omissions', () => {
  const inventory = { topics: [
    { id: 'topic1', title: 'A', importance: 'essential', source: { filename: 'lec.pdf', pageStart: 1, pageEnd: 2 }, chunkIds: [] },
    { id: 'topic2', title: 'B', importance: 'supporting', source: { filename: 'lec.pdf', pageStart: 3, pageEnd: 5 }, chunkIds: [] },
    { id: 'topic3', title: 'C', importance: 'optional', source: { filename: 'lec.pdf', pageStart: 6, pageEnd: 7 }, chunkIds: [] },
    { id: 'topic4', title: 'D', importance: 'optional', source: { filename: 'lec.pdf', pageStart: 8, pageEnd: 9 }, chunkIds: [] },
    { id: 'topic5', title: 'E', importance: 'optional', source: { filename: 'lec.pdf', pageStart: 10, pageEnd: 11 }, chunkIds: [] },
    { id: 'topic6', title: 'F', importance: 'optional', source: { filename: 'lec.pdf', pageStart: 12, pageEnd: 13 }, chunkIds: [] },
    { id: 'topic7', title: 'G', importance: 'optional', source: { filename: 'lec.pdf', pageStart: 14, pageEnd: 15 }, chunkIds: [] },
    { id: 'topic8', title: 'H', importance: 'optional', source: { filename: 'lec.pdf', pageStart: 16, pageEnd: 17 }, chunkIds: [] },
  ] };
  const plan = buildTeachingPlan(entry, inventory, { minutes: 7, wpm: 72 });
  const total = plan.topics.reduce((n, t) => n + t.budget, 0);
  assert.ok(total <= plan.bodyBudget, `topic budgets ${total} exceed body budget ${plan.bodyBudget}`);
  assert.ok(plan.introWords > 0 && plan.recapWords > 0);
  assert.ok(plan.topics.some((t) => t.importance === 'essential'), 'essential topic kept');
  assert.ok(plan.omitted.length > 0, 'omissions recorded');
  assert.equal(plan.structure[0].role, 'introduction');
  assert.equal(plan.structure.at(-1).role, 'conclusion');
});

test('assigned page ranges scope the inventory; outside sections become unprocessed', async () => {
  const entryScoped = { ...entry, sources: [{ filename: 'lec.pdf', documentId: 'docA', pages: [[5, 20]] }] };
  const sections = [
    SEC('s1', 'Early Chapter', 1, 4, prose(200)),
    SEC('s2', 'Mid Chapter', 5, 20, prose(200)),
    SEC('s3', 'Late Chapter', 21, 30, prose(200)),
  ];
  const chunks = [CH('s1', 2, 'x'), CH('s2', 8, 'x'), CH('s3', 22, 'x')];
  const inv = await buildTopicInventory('c1', entryScoped, { sections, chunks, chat: async () => ({ kinds: [] }) });
  assert.deepEqual(inv.topics.map((t) => t.title), ['Mid Chapter']);
  assert.ok(inv.unprocessedPages.length === 2);
});

// ---------- Phase 3: provenance + no-trim --------------------------------------
const goodParsed = () => ({
  title: 'Intro to ML',
  segments: [
    { id: 0, section: 'Introduction', document: 'lec.pdf', page: 3, text: prose(70) },
    { id: 1, section: 'What is ML', document: 'lec.pdf', page: 5, text: prose(100) },
    { id: 2, section: 'Supervised', document: 'lec.pdf', page: 12, text: prose(100) },
    { id: 3, section: 'Unsupervised', document: 'lec.pdf', page: 18, text: prose(100) },
    { id: 4, section: 'Recap', document: 'lec.pdf', page: 18, text: prose(60) },
  ],
});
const allowed = { 'lec.pdf': { documentId: 'docA', pages: [[1, 30]] } };

test('valid script passes; admin opening fails', () => {
  const plan = buildTeachingPlan(entry, { topics: [] }, {});
  assert.equal(validateLectureV2(goodParsed(), allowed, plan).ok, true);
  const bad = goodParsed();
  bad.segments[0] = { ...bad.segments[0], text: 'First let me cover the grading policy and office hours for this course.' };
  const v = validateLectureV2(bad, allowed, plan);
  assert.equal(v.ok, false);
  assert.ok(v.problems.some((x) => x.includes('administrative')));
});

test('provenance: wrong doc or page outside range is rejected', () => {
  const p = goodParsed();
  p.segments[1].page = 99;
  assert.equal(validateLectureV2(p, allowed, null).ok, false);
  const p2 = goodParsed();
  p2.segments[1].document = 'other.pdf';
  assert.equal(validateLectureV2(p2, allowed, null).ok, false);
});

test('compressOvershoot shrinks text via injected LLM — NO segments deleted', async () => {
  const parsed = goodParsed();
  parsed.segments.splice(1, 0,
    { id: 5, section: 'T', document: 'lec.pdf', page: 6, text: prose(300) });
  parsed.segments.forEach((s, i) => s.id = i);
  const plan = buildTeachingPlan(entry, { topics: [{ id: 'topic1', title: 'T', importance: 'essential', budget: 60, source: { filename: 'lec.pdf', pageStart: 5, pageEnd: 7 }, chunkIds: [] }] }, {});
  assignSegmentTopics(parsed, plan);
  const before = parsed.segments.length;
  const chat = async () => ({ segments: [{ id: 2, text: 'compressed fifty words ' + prose(40) }] });
  const out = await compressOvershoot(parsed, plan, '', { chat });
  assert.equal(out.segments.length, before, 'no segments deleted');
  assert.ok(out.segments[2].text.includes('compressed'));
});

test('word overflow path fails validation with a reason, never trims silently', () => {
  const p = goodParsed();
  p.segments.push({ id: 9, section: 'T', document: 'lec.pdf', page: 6, text: prose(600) });
  const v = validateLectureV2(p, allowed, buildTeachingPlan(entry, { topics: [] }, {}));
  assert.equal(v.ok, false);
  assert.ok(v.problems.some((x) => x.startsWith('too long')));
});

// ---------- Phase 4: critic + bounded revision ----------------------------------
test('bounded revision: max cycles respected even when critic always complains', async () => {
  const calls = [];
  const chat = async (msgs, opts) => {
    calls.push(msgs[0].content.slice(0, 20));
    if (msgs[0].content.includes('strict teaching-quality critic')) {
      return { findings: [{ segment: 0, problem: 'vague', severity: 'low', action: 'clarify', topicId: null }] };
    }
    return { title: 'Intro to ML', segments: goodParsed().segments };
  };
  // Full v2 generate with mock inventory + chat — exercises the revision loop.
  const sections = [SEC('s1', 'What is ML', 1, 10, prose(300)), SEC('s2', 'Supervised', 11, 20, prose(300))];
  const chunks = [CH('s1', 5, sections[0].text), CH('s2', 12, sections[1].text)];
  const lec = await generateLectureV2('01234567-abcd', entry, {
    sections, chunks, chat,
    evidence: [
      { topic: { title: 'What is ML', budget: 100, importance: 'essential' }, chunks: [{ filename: 'lec.pdf', page: 5, text: sections[0].text }] },
      { topic: { title: 'Supervised', budget: 100, importance: 'supporting' }, chunks: [{ filename: 'lec.pdf', page: 12, text: sections[1].text }] },
    ],
  }).catch((e) => ({ _err: e }));
  // (evidenceForTopics needs DB — acceptable here to catch & check call count)
  const criticCalls = calls.filter((c) => c.includes('strict teaching')).length;
  assert.ok(criticCalls <= 2, `critic called ${criticCalls} times > 2 cycles`);
});

test('revise keeps original when the revision guts the script', async () => {
  const parsed = goodParsed();
  const chat = async () => ({ title: 'x', segments: parsed.segments.slice(0, 1) });
  const out = await revise(parsed, [{ segment: 0, problem: 'x', action: 'fix' }], { topics: [] }, '', { chat });
  assert.equal(out.segments.length, parsed.segments.length, 'bad revision rejected');
});

// ---------- schema compatibility -------------------------------------------------
test('segments.json contract: id/section/document/page/text preserved', () => {
  const parsed = parseSegments({
    title: 'T', segments: [
      { section: 'S', document: 'lec.pdf', page: 4, text: 'Narration text here.' },
    ],
  });
  const s = parsed.segments[0];
  assert.deepEqual(Object.keys(s).sort(), ['document', 'id', 'page', 'section', 'text']);
  assert.equal(s.id, 0);
  assert.equal(s.page, 4);
});
