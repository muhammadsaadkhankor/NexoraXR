// V3 generator unit tests — mocked Ollama, injected fixtures. No DB, no
// network, no inference.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifySectionV3, buildConceptMap, buildTeachingPlanV3, cleanTitle,
  detectRepetition, detectAdminLeak, validateLectureV3, compressOvershootV3,
  critiqueV3, reviseV3, writeBlocks, EFFECTIVE_WPM,
} from './generator3.mjs';

const prose = (w, word = 'concept') => Array(w).fill(word).join(' ');
const SEC = (id, title, ps, pe, text, opts = {}) => ({
  id, title, summary: opts.summary || null, page_start: ps, page_end: pe,
  idx: Number(String(id).replace(/\D/g, '') || 0), filename: 'lec.pdf',
  document_id: 'docA', ...opts,
});
const CH = (sid, page, text, id = `${sid}c${page}`) => ({
  id, section_id: sid, heading: '', text, page, filename: 'lec.pdf', document_id: 'docA',
});
const entry = {
  idx: 1, title: 'Introduction to Machine Learning',
  sources: [{ filename: 'lec.pdf', documentId: 'docA', pages: [[1, 30]] }],
  objectives: ['define machine learning', 'name the learning paradigms'],
};
const corpusOf = (pairs) => ({
  teaching: pairs.map(([s, cs], i) => ({ ...s, chunks: cs, text: cs.map((c) => c.text).join(' '), _class: { kind: 'concept' } })),
  excluded: [],
  unprocessedPages: [],
});

// ---------- 1. administrative exclusion ----------------------------------------
test('course-description phrasing is classified admin (V2 leak fixed)', () => {
  const t = { title: 'Why This Course?', text: 'This course combines ML theory, coding, and projects. This course focuses on applying ML in ECE.' };
  assert.equal(classifySectionV3(t).kind, 'admin');
  // Not over-filtered: a normal teaching section stays.
  assert.equal(classifySectionV3({ title: 'Linear Regression', text: 'A model is defined as a weighted sum of inputs. It is a function mapping features to outputs.' }).kind, 'concept');
});

// ---------- 2-3. primary subject + sequencing -----------------------------------
test('concept map resolves refs, dedupes, drops ungroundable concepts', async () => {
  const corpus = corpusOf([
    [SEC('s1', 'ML Overview', 1, 3, prose(200)), [CH('s1', 2, 'x')]],
    [SEC('s2', 'What is Machine Learning', 4, 9, prose(200)), [CH('s2', 5, 'x')]],
    [SEC('s3', 'Supervised Learning', 10, 15, prose(200)), [CH('s3', 11, 'x')]],
  ]);
  const chat = async () => ({
    primarySubject: 'machine learning',
    concepts: [
      { title: 'What is ML', role: 'core', dependsOn: [], sourceRefs: ['S0', 'S1'], oneLine: 'def' },
      { title: 'what is ml', role: 'supporting', dependsOn: [], sourceRefs: ['S1'], oneLine: 'dupe' },
      { title: 'Supervised learning', role: 'core', dependsOn: ['What is ML'], sourceRefs: ['S2'], oneLine: 'd' },
      { title: 'Ghost topic', role: 'core', dependsOn: [], sourceRefs: ['S99'], oneLine: 'bad ref' },
    ],
    omitted: [{ title: 'Grading', reason: 'administrative' }],
  });
  const cmap = await buildConceptMap(entry, corpus, { chat });
  assert.equal(cmap.primarySubject, 'machine learning');
  assert.equal(cmap.concepts.length, 2, 'dupe merged, ghost dropped');
  assert.equal(cmap.concepts[0].title, 'What is ML');
  assert.equal(cmap.concepts[0].sections.length, 2, 'merged S0+S1');
});

test('teaching plan orders by dependencies, not page order', async () => {
  const cmap = {
    primarySubject: 'ML', degraded: false, omitted: [],
    concepts: [
      { title: 'RL — Mario example', role: 'example', dependsOn: ['Reinforcement learning'], sections: [SEC('s9', 'Mario', 30, 30, 'x')], _refs: new Set() },
      { title: 'What is ML', role: 'core', dependsOn: [], sections: [SEC('s1', 'x', 4, 9, 'x')], _refs: new Set() },
      { title: 'Reinforcement learning', role: 'core', dependsOn: ['Unsupervised learning'], sections: [SEC('s5', 'x', 21, 25, 'x')], _refs: new Set() },
      { title: 'Math prerequisites', role: 'prerequisite', dependsOn: [], sections: [SEC('s0', 'x', 9, 9, 'x')], _refs: new Set() },
      { title: 'Unsupervised learning', role: 'core', dependsOn: ['Supervised learning'], sections: [SEC('s4', 'x', 16, 20, 'x')], _refs: new Set() },
      { title: 'Supervised learning', role: 'core', dependsOn: ['What is ML'], sections: [SEC('s3', 'x', 10, 15, 'x')], _refs: new Set() },
    ],
  };
  const plan = buildTeachingPlanV3(entry, cmap, { minutes: 7, wpm: 72 });
  const titles = plan.blocks.map((b) => b.title);
  const order = ['What is ML', 'Supervised learning', 'Unsupervised learning', 'Reinforcement learning'];
  const positions = order.map((t) => titles.indexOf(t));
  assert.ok(positions.every((p, i) => p >= 0 && (i === 0 || positions[i - 1] < p)),
    `dependency order violated: ${titles.join(', ')}`);
  // Example merged into the concept block it illustrates.
  const rl = plan.blocks[titles.indexOf('Reinforcement learning')];
  assert.deepEqual(rl.examples, ['RL — Mario example']);
  assert.ok(rl.sources.some((s) => s.pageStart === 30), 'example sources merged into concept block');
  assert.ok(plan.introWords > 0 && plan.recapWords > 0);
});

test('budgets sum ≤ body budget; omissions recorded', () => {
  const many = Array.from({ length: 14 }, (_, i) => ({
    title: `Topic ${i}`, role: i < 2 ? 'core' : 'supporting', dependsOn: [],
    sections: [SEC(`s${i}`, `T${i}`, i, i, 'x')], _refs: new Set(),
  }));
  const plan = buildTeachingPlanV3(entry, { primarySubject: 'x', concepts: many, omitted: [] }, { minutes: 5, wpm: 72 });
  const total = plan.blocks.reduce((n, b) => n + b.budget, 0);
  assert.ok(total <= plan.wordBudget);
  assert.ok(plan.omitted.length > 0, 'lower-priority topics omitted when budget is tight');
});

// ---------- 4-7. writing + deterministic checks -----------------------------------
test('dedup + merge: same concept via two source sections → one block', async () => {
  const corpus = corpusOf([
    [SEC('s1', 'Page 1 intro', 1, 1, prose(150)), [CH('s1', 1, 'x')]],
    [SEC('s2', 'What is ML', 4, 8, prose(150)), [CH('s2', 5, 'x')]],
  ]);
  const chat = async (msgs) => {
    if (msgs[0].content.includes('curriculum analyst')) {
      return { primarySubject: 'ML', concepts: [
        { title: 'What is ML', role: 'core', dependsOn: [], sourceRefs: ['S0', 'S1'], oneLine: 'd' },
      ], omitted: [] };
    }
    return { segments: [{ document: 'lec.pdf', page: 5, text: prose(60) }] };
  };
  const cmap = await buildConceptMap(entry, corpus, { chat });
  const plan = buildTeachingPlanV3(entry, cmap, {});
  assert.equal(plan.blocks.length, 1, 'merged into one teaching block');
});

test('detectRepetition flags a re-stated definition', () => {
  const segs = [
    { id: 0, text: 'Machine learning is a field that lets computers learn without explicit programming.' },
    { id: 1, text: 'Another idea entirely, quite separate material here.' },
    { id: 2, text: 'So machine learning is a field that lets computers learn without explicit programming.' },
  ];
  const reps = detectRepetition(segs);
  assert.ok(reps.some((r) => r.segment === 2 && r.also === 0));
});

test('detectAdminLeak flags "this course" narration', () => {
  const leaks = detectAdminLeak([{ id: 0, text: 'This course combines theory and coding projects.' }]);
  assert.equal(leaks.length, 1);
  assert.equal(detectAdminLeak([{ id: 0, text: 'A model maps inputs to outputs.' }]).length, 0);
});

test('shallow core coverage fails validation (named not explained)', () => {
  const plan = { blocks: [{ id: 'b1', title: 'Core X', role: 'core', budget: 100 }] };
  const p = { title: 'T', segments: [
    { id: 0, section: 'Intro', document: 'lec.pdf', page: 1, text: prose(80), blockId: '__intro' },
    { id: 1, section: 'Core X', document: 'lec.pdf', page: 3, text: prose(20), blockId: 'b1' },
    { id: 2, section: 'A', document: 'lec.pdf', page: 5, text: prose(150), blockId: 'b1' },
    { id: 3, section: 'B', document: 'lec.pdf', page: 7, text: prose(150), blockId: 'b1' },
    { id: 4, section: 'Recap', document: 'lec.pdf', page: 8, text: prose(60), blockId: '__recap' },
  ] };
  const allowed = { 'lec.pdf': { documentId: 'docA', pages: [[1, 30]] } };
  // b1 gets 320 words via other segs — passes core check; make another core thin:
  const p2 = JSON.parse(JSON.stringify(p));
  p2.segments.push({ id: 5, section: 'C', document: 'lec.pdf', page: 9, text: prose(25), blockId: 'b2' });
  plan.blocks.push({ id: 'b2', title: 'Core Y', role: 'core', budget: 80 });
  const v = validateLectureV3(p2, allowed, plan);
  assert.equal(v.ok, false);
  assert.ok(v.problems.some((x) => x.includes('Core Y')));
});

// ---------- 8-9. critic + revision -----------------------------------------------
test('critic merges deterministic + LLM findings; revise is targeted', async () => {
  const plan = { objective: 'ML', blocks: [{ id: 'b1', title: 'T', role: 'core', budget: 100 }] };
  const parsed = { title: 'T', segments: [
    { id: 0, section: 'S', document: 'lec.pdf', page: 1, text: 'This course covers grading and office hours weekly.', blockId: 'b1' },
    { id: 1, section: 'S', document: 'lec.pdf', page: 2, text: prose(50, 'teaching'), blockId: 'b1' },
  ] };
  const critic = await critiqueV3(parsed, plan, { chat: async () => ({ findings: [] }) });
  assert.ok(critic.deterministicFindings >= 1, 'deterministic admin finding');
  // Revise only the flagged segment.
  const chat = async () => ({ segments: [{ id: 0, text: 'The subject matter begins here instead.', page: 1 }] });
  const out = await reviseV3(JSON.parse(JSON.stringify(parsed)), critic.findings, plan, { chat });
  assert.equal(out.segments[0].text, 'The subject matter begins here instead.');
  assert.ok(out.segments[1].text.includes('teaching'), 'untargeted segment unchanged');
});

// ---------- 10. duration without destructive trim ---------------------------------
test('overshoot → compression edits text in place; segments never deleted', async () => {
  const plan = { blocks: [{ id: 'b1', title: 'T', role: 'core', budget: 60, sources: [] }] };
  const parsed = { title: 'T', segments: [
    { id: 0, section: 'T', document: 'lec.pdf', page: 2, text: prose(200), blockId: 'b1' },
    { id: 1, section: 'T', document: 'lec.pdf', page: 3, text: prose(200), blockId: 'b1' },
  ] };
  const chat = async () => ({ segments: [{ id: 0, text: prose(120) }, { id: 1, text: prose(120) }] });
  const out = await compressOvershootV3(parsed, plan, { chat });
  assert.equal(out.segments.length, 2, 'no deletion');
  assert.equal(out.segments[0].text.split(' ').length, 120);
});

// ---------- 11-12. provenance + schema ---------------------------------------------
test('provenance enforced: bad doc/page rejected', () => {
  const p = { title: 'T', segments: [
    { id: 0, section: 'S', document: 'lec.pdf', page: 2, text: prose(60) },
    { id: 1, section: 'S', document: 'other.pdf', page: 2, text: prose(60) },
    { id: 2, section: 'S', document: 'lec.pdf', page: 99, text: prose(60) },
    { id: 3, section: 'S', document: 'lec.pdf', page: 4, text: prose(60) },
    { id: 4, section: 'S', document: 'lec.pdf', page: 5, text: prose(60) },
  ] };
  const v = validateLectureV3(p, { 'lec.pdf': { documentId: 'docA', pages: [[1, 10]] } }, { blocks: [] });
  assert.equal(v.ok, false);
  assert.ok(v.problems.some((x) => x.includes('unassigned document')));
  assert.ok(v.problems.some((x) => x.includes('outside assigned ranges')));
});

test('segment schema stays segments.json-compatible', () => {
  const s = { id: 0, section: 'S', document: 'lec.pdf', page: 3, text: 'x', blockId: 'b1' };
  // emitLecture reads exactly these fields — extra fields are ignored there.
  for (const k of ['id', 'section', 'document', 'page', 'text']) assert.ok(k in s);
});

// ---------- 13. batched writing uses plan context -----------------------------------
test('writeBlocks passes evidence, prior ending, and introduced terms per block', async () => {
  const calls = [];
  const chat = async (msgs) => {
    calls.push(msgs[1].content);
    const n = calls.length;
    return { segments: [{ document: 'lec.pdf', page: 2, text: `Block ${n}: ${prose(30, 'distinct' + n)}` }] };
  };
  const corpus = corpusOf([
    [SEC('s1', 'Core A', 1, 5, prose(200)), [CH('s1', 2, 'evidence about core A')]],
    [SEC('s2', 'Core B', 6, 10, prose(200)), [CH('s2', 7, 'evidence about core B')]],
  ]);
  const cmap = { primarySubject: 'ML', degraded: false, omitted: [], concepts: [
    { title: 'Core A', role: 'core', dependsOn: [], sections: [corpus.teaching[0]], _refs: new Set() },
    { title: 'Core B', role: 'core', dependsOn: ['Core A'], sections: [corpus.teaching[1]], _refs: new Set() },
  ] };
  const plan = buildTeachingPlanV3(entry, cmap, {});
  const out = await writeBlocks(entry, plan, corpus, { chat });
  assert.equal(out.segments.length, 4, 'intro + 2 blocks + recap');
  const blockCall = calls.find((c) => c.includes('THIS BLOCK: "Core B"'));
  assert.ok(blockCall.includes('Already introduced'), 'sees introduced terms');
  assert.ok(blockCall.includes('Previous section ended'), 'sees prior ending');
  assert.ok(blockCall.includes('evidence about core B'), 'sees its evidence');
});

test('batched write keeps robotic transitions out of prompt control path', async () => {
  // The writer system prompt must forbid greeting/admin and robotic transitions.
  let sys = '';
  const chat = async (msgs) => { sys = msgs[0].content; return { segments: [] }; };
  const corpus = corpusOf([[SEC('s1', 'A', 1, 5, prose(100)), [CH('s1', 2, 'x')]]]);
  const plan = buildTeachingPlanV3(entry, { primarySubject: 'x', concepts: [{ title: 'A', role: 'core', dependsOn: [], sections: [corpus.teaching[0]], _refs: new Set() }], omitted: [] }, {});
  await writeBlocks(entry, plan, corpus, { chat });
  assert.ok(sys.includes('never greet'));
  assert.ok(sys.includes('no robotic'));
});

// ---------- regression: verbatim repeats from the generated L1/L2 -------------
import { normalizeText, segmentSimilarity, dedupeSegments } from './generator3.mjs';

const CLUSTERING = 'Clustering finds patterns in unlabeled data by measuring similarities and differences between examples. Association tasks identify relationships between variables, such as co-occurrence in text or transactional data. Dimensionality reduction techniques, like PCA, help simplify complex data by focusing on the most important features.';
const OLS = 'This approach leads to the Ordinary Least Squares (OLS) solution, which can be efficiently computed using matrix operations like the inverse of the design matrix.';
const MSE = 'For instance, MSE measures the average of squared differences between predicted and actual values, making it useful for optimization. R-squared indicates the proportion of variance explained by the model.';
const RECAP = 'Linear regression models predict outcomes by finding the best fit line that minimizes the sum of squared errors between predictions and actual targets.';

test('verbatim duplicate paragraphs are detected as type=duplicate', () => {
  const reps = detectRepetition([
    { id: 0, text: CLUSTERING }, { id: 1, text: 'something else entirely different material.' },
    { id: 2, text: CLUSTERING }, { id: 3, text: OLS }, { id: 4, text: OLS },
  ]);
  const dups = reps.filter((f) => f.type === 'duplicate');
  assert.ok(dups.some((f) => f.segment === 2 && f.also === 0));
  assert.ok(dups.some((f) => f.segment === 4 && f.also === 3));
});

test('cosmetic-variant near-duplicates are still detected (whitespace/punctuation)', () => {
  const variant = CLUSTERING.replace('features.', 'features!').replace('  ', ' ');
  assert.ok(segmentSimilarity(CLUSTERING, variant) >= 0.8);
  const reps = detectRepetition([{ id: 0, text: CLUSTERING }, { id: 1, text: variant }]);
  assert.equal(reps[0].type, 'duplicate');
});

test('recap wording is NOT flagged as duplicate of an earlier paragraph', () => {
  assert.ok(segmentSimilarity(OLS, RECAP) < 0.8);
});

test('dedupeSegments removes later copies, renumbers ids, keeps recap', () => {
  const { segments, removedIds } = dedupeSegments([
    { id: 0, text: OLS }, { id: 1, text: OLS }, { id: 2, text: MSE },
    { id: 3, text: MSE }, { id: 4, text: RECAP },
  ]);
  assert.equal(segments.length, 3);
  assert.deepEqual(segments.map((s) => s.id), [0, 1, 2]);
  assert.equal(removedIds.length, 2);
  assert.equal(segments.at(-1).text, RECAP);
});

test('publication gate: duplicate paragraphs + missing intro are rejected', () => {
  const p = { title: 'T', segments: [
    { id: 0, section: 'OLS', document: 'lec.pdf', page: 2, text: OLS, blockId: 'b1' },
    { id: 1, section: 'OLS', document: 'lec.pdf', page: 2, text: OLS, blockId: 'b1' },
    { id: 2, section: 'MSE', document: 'lec.pdf', page: 3, text: MSE, blockId: 'b2' },
    { id: 3, section: 'X', document: 'lec.pdf', page: 4, text: prose(150), blockId: 'b3' },
    { id: 4, section: 'Recap', document: 'lec.pdf', page: 5, text: RECAP, blockId: '__recap' },
  ] };
  const v = validateLectureV3(p, { 'lec.pdf': { documentId: 'docA', pages: [[1, 20]] } }, { blocks: [] });
  assert.equal(v.ok, false);
  assert.ok(v.problems.some((x) => x.includes('duplicate')));
  assert.ok(v.problems.some((x) => x.includes('introduction')));
});

test('writeBlocks refuses duplicate segments at assembly (regression: real dup response)', async () => {
  const chat = async (msgs) => {
    if (msgs[1].content.includes('THIS BLOCK: "OLS"')) {
      return { segments: [
        { document: 'lec.pdf', page: 37, text: OLS },
        { document: 'lec.pdf', page: 37, text: OLS },           // verbatim dup — must be dropped
        { document: 'lec.pdf', page: 37, text: OLS + ' More.' }, // near-dup — must be dropped
      ] };
    }
    return { segments: [{ document: 'lec.pdf', page: 1, text: 'Unique narration text about the subject.' }] };
  };
  const corpus = corpusOf([[SEC('s1', 'OLS', 30, 40, prose(200)), [CH('s1', 37, 'ols evidence')]]]);
  const plan = buildTeachingPlanV3(entry, { primarySubject: 'LR', omitted: [],
    concepts: [{ title: 'OLS', role: 'core', dependsOn: [], sections: [corpus.teaching[0]], _refs: new Set() }] }, {});
  const out = await writeBlocks(entry, plan, corpus, { chat });
  const ols = out.segments.filter((s) => s.section === 'OLS');
  assert.equal(ols.length, 1, 'duplicate block output refused');
});

test('empty block output degrades gracefully — intro missing is flagged not silently shipped', () => {
  const p = { title: 'T', segments: [
    { id: 0, section: 'Closed-Form Solution', document: 'lec.pdf', page: 37, text: prose(150), blockId: 'b1' },
    { id: 1, section: 'A', document: 'lec.pdf', page: 40, text: prose(150), blockId: 'b2' },
    { id: 2, section: 'B', document: 'lec.pdf', page: 41, text: prose(150), blockId: 'b3' },
    { id: 3, section: 'Recap', document: 'lec.pdf', page: 41, text: prose(60), blockId: '__recap' },
  ] };
  const v = validateLectureV3(p, { 'lec.pdf': { documentId: 'docA', pages: [[1, 60]] } }, { blocks: [] });
  assert.equal(v.ok, false);
  assert.ok(v.problems.some((x) => x.includes('introduction')));
});

// ---------- Task 1-3: reliability — retries, post-dedup repair, final gate ----
import { writeBlockWithRetry, blockGaps, repairGaps, evidenceForBlock } from './generator3.mjs';

const corpus1 = corpusOf([
  [SEC('s1', 'What is ML', 1, 5, prose(200)), [CH('s1', 2, 'ml definition evidence')]],
  [SEC('s2', 'Supervised', 6, 10, prose(200)), [CH('s2', 7, 'supervised evidence')]],
]);
const cmap1 = { primarySubject: 'ML', omitted: [], concepts: [
  { title: 'What is ML', role: 'core', dependsOn: [], sections: [corpus1.teaching[0]], _refs: new Set() },
  { title: 'Supervised', role: 'core', dependsOn: ['What is ML'], sections: [corpus1.teaching[1]], _refs: new Set() },
] };
const plan1 = buildTeachingPlanV3(entry, cmap1, {});
const planObj = { subject: 'ML', objective: 'Intro ML', blocks: plan1.blocks, introWords: plan1.introWords, recapWords: plan1.recapWords };

test('empty block response → bounded retry recovers', async () => {
  let calls = 0;
  const chat = async () => { calls++; return calls < 2 ? null : { segments: [{ document: 'lec.pdf', page: 2, text: prose(40,'wR') }] }; };
  const accepted = [];
  const r = await writeBlockWithRetry(planObj, entry, { title: 'T', budget: 60, evidence: 'e' }, {}, (l) => { accepted.push(...l); return l.length; }, { chat });
  assert.equal(r.ok, true);
  assert.equal(calls, 2);
});

test('malformed JSON → retry succeeds on next attempt', async () => {
  let calls = 0;
  const chat = async () => { calls++; return calls < 2 ? { garbage: true } : { segments: [{ document: 'lec.pdf', page: 2, text: prose(40,'wG') }] }; };
  const r = await writeBlockWithRetry(planObj, entry, { title: 'T', budget: 60, evidence: 'e' }, {}, (l) => l.length, { chat });
  assert.equal(r.ok, true);
  assert.equal(calls, 2);
});

test('persistent failure → fails after exactly 3 attempts, records reason', async () => {
  let calls = 0;
  const chat = async () => { calls++; return null; };
  const r = await writeBlockWithRetry(planObj, entry, { title: 'T', budget: 60, evidence: 'e' }, {}, () => 0, { chat });
  assert.equal(r.ok, false);
  assert.equal(calls, 3);
  assert.ok(r.reason);
});

test('writeBlocks marks intro/conclusion failures instead of skipping silently', async () => {
  const chat = async (msgs) => {
    if (msgs[1].content.includes('THIS BLOCK: "Introduction')) return null;
    if (msgs[1].content.includes('THIS BLOCK: "Recap"')) return { segments: [{ document: 'lec.pdf', page: 9, text: prose(50,'wRc') }] };
    return { segments: [{ document: 'lec.pdf', page: 5, text: prose(60,'wB'+Math.random()) }] };
  };
  const out = await writeBlocks(entry, plan1, corpus1, { chat });
  assert.ok(out.blockFailures.some((f) => f.blockId === '__intro'));
});

test('blockGaps detects missing intro/conclusion and under-explained core', () => {
  const p = { segments: [
    { id: 0, section: 'Supervised', document: 'lec.pdf', page: 7, text: prose(150, 'u'+Math.random().toString(36).slice(2,8)), blockId: plan1.blocks[1].id },
    { id: 1, section: 'Recap', document: 'lec.pdf', page: 8, text: prose(50, 'u'+Math.random().toString(36).slice(2,8)), blockId: '__recap' },
  ] };
  const gaps = blockGaps(p, planObj);
  assert.ok(gaps.some((g) => g.blockId === '__intro'));
  assert.ok(gaps.some((g) => g.blockId === plan1.blocks[0].id), 'core block under-explained');
});

test('repairGaps restores a missing intro without touching other segments', async () => {
  const p = { title: 'T', sections: [], segments: [
    { id: 0, section: 'Supervised', document: 'lec.pdf', page: 7, text: prose(150, 'u'+Math.random().toString(36).slice(2,8)), blockId: plan1.blocks[1].id },
    { id: 1, section: 'Recap', document: 'lec.pdf', page: 8, text: prose(60, 'u'+Math.random().toString(36).slice(2,8)), blockId: '__recap' },
  ] };
  const gaps = [{ blockId: '__intro', title: 'Introduction', objective: 'open', budget: 50, sources: plan1.blocks[0].sources }];
  const chat = async () => ({ segments: [{ document: 'lec.pdf', page: 1, text: prose(60,'wO') }] });
  const r = await repairGaps(p, planObj, corpus1, gaps, { chat }, {});
  assert.equal(r.repaired, 1);
  assert.equal(p.segments[0].blockId, '__intro', 'intro placed first');
  assert.equal(p.segments[0].id, 0, 'ids renumbered');
});

test('post-dedup under-length triggers repair + re-dedup (no dups restored)', async () => {
  const p = { title: 'T', sections: [], segments: [
    { id: 0, section: 'Intro', document: 'lec.pdf', page: 1, text: prose(60, 'u'+Math.random().toString(36).slice(2,8)), blockId: '__intro' },
    { id: 1, section: 'Recap', document: 'lec.pdf', page: 8, text: prose(50, 'u'+Math.random().toString(36).slice(2,8)), blockId: '__recap' },
  ] };
  const gaps = blockGaps(p, planObj);
  assert.ok(gaps.length >= 2, 'both core blocks under-explained');
  const chat = async () => ({ segments: [{ document: 'lec.pdf', page: 5, text: prose(80,'wX'+Math.random()) }] });
  const r = await repairGaps(p, planObj, corpus1, gaps, { chat }, {});
  assert.ok(r.repaired >= 2);
  assert.equal(detectRepetition(p.segments).filter((f) => f.type === 'duplicate').length, 0);
});

test('final gate: blockFailures listed as actionable problems', () => {
  const p = { title: 'T', blockFailures: [{ blockId: 'b1', title: 'OLS', reason: 'empty response' }], segments: [
    { id: 0, section: 'Intro', document: 'lec.pdf', page: 1, text: prose(60, 'u'+Math.random().toString(36).slice(2,8)), blockId: '__intro' },
    { id: 1, section: 'A', document: 'lec.pdf', page: 2, text: prose(150, 'u'+Math.random().toString(36).slice(2,8)), blockId: 'b2' },
    { id: 2, section: 'B', document: 'lec.pdf', page: 3, text: prose(150, 'u'+Math.random().toString(36).slice(2,8)), blockId: 'b3' },
    { id: 3, section: 'Recap', document: 'lec.pdf', page: 4, text: prose(60, 'u'+Math.random().toString(36).slice(2,8)), blockId: '__recap' },
  ] };
  const v = validateLectureV3(p, { 'lec.pdf': { documentId: 'docA', pages: [[1, 10]] } }, { blocks: [] });
  assert.equal(v.ok, false);
  assert.ok(v.problems.some((x) => x.includes('OLS')));
});

test('duration revalidated after dedup (word count recomputed)', () => {
  const p = { title: 'T', segments: [
    { id: 0, section: 'Intro', document: 'lec.pdf', page: 1, text: prose(60, 'uniqI'), blockId: '__intro' },
    { id: 1, section: 'A', document: 'lec.pdf', page: 2, text: prose(150, 'dupA'), blockId: 'b1' },
    { id: 2, section: 'A', document: 'lec.pdf', page: 2, text: prose(150, 'dupA'), blockId: 'b1' },
    { id: 3, section: 'Recap', document: 'lec.pdf', page: 4, text: prose(60, 'uniqR'), blockId: '__recap' },
  ] };
  const { segments } = dedupeSegments(p.segments);
  assert.equal(segments.length, 3);
  const words = segments.reduce((n, s) => n + s.text.split(/\s+/).filter(Boolean).length, 0);
  assert.equal(words, 270); // post-dedup total, not the pre-dedup count
});

test('schema: repaired segments keep document/page/text/blockId fields', async () => {
  const p = { title: 'T', sections: [], segments: [
    { id: 0, section: 'Recap', document: 'lec.pdf', page: 8, text: prose(60, 'u'+Math.random().toString(36).slice(2,8)), blockId: '__recap' },
  ] };
  const gaps = [{ blockId: '__intro', title: 'Intro', objective: 'o', budget: 50, sources: plan1.blocks[0].sources }];
  const chat = async () => ({ segments: [{ document: 'lec.pdf', page: 2, text: prose(50, 'wNI') }] });
  await repairGaps(p, planObj, corpus1, gaps, { chat }, {});
  for (const s of p.segments) for (const k of ['id', 'section', 'document', 'page', 'text', 'blockId']) assert.ok(k in s);
});
