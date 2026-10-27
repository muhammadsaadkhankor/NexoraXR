// Lecture script generator V2 — topic-aware, pedagogically structured.
//
// Pipeline per lecture:
//   assigned sources → classify sections (admin/refs/exercises out) →
//   TOPIC INVENTORY (document traversal, not top-k retrieval) →
//   TEACHING PLAN (ranked topics + word budgets + explicit omissions) →
//   NARRATION (per-topic budgeted, provenance-preserving segments) →
//   LENGTH CONTROL (budget-driven compression — NEVER segment deletion) →
//   STRUCTURED CRITIC → targeted revision (≤2 cycles) → final validation.
//
// V1 (generator.mjs) stays intact as the reproducible baseline; selects via
// COURSE_GENERATOR=v1|v2 (default v2).

import path from 'node:path';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { getPool } from '../db/pool.mjs';
import { chat as defaultChat } from './llm.mjs';
import { parseSegments, segsToSections, retrieveChunks } from './generator.mjs';
import { isAdminText, ADMIN_NARRATION } from './admin.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PROFBRAIN_DIR = path.join(REPO_ROOT, 'profbrain', 'lectures');
const EVAL_DIR = path.join(REPO_ROOT, 'eval', 'records');

export const GENERATOR_VERSION = 'v2.1';
export const PROMPT_VERSION = 'v2-plan-2026-10-26';

// ---- configuration ---------------------------------------------------------
// Duration target: configurable 5–10 min; DEFAULT 7 min for V2.
// Effective WPM is CALIBRATED from measured VoxCPM output on this box
// (~65–80 wpm, see earlier bake runs: 310w→262s≈71wpm, 401w→372s≈65wpm).
// We use 72 wpm midpoint — NOT the naive ~130 wpm a screen-reader assumes.
const TARGET_MINUTES = Math.min(10, Math.max(5, Number(process.env.COURSE_TARGET_MINUTES || 7)));
export const EFFECTIVE_WPM = Math.min(130, Math.max(50, Number(process.env.COURSE_EFFECTIVE_WPM || 72)));
const WORD_BUDGET = Math.round(TARGET_MINUTES * EFFECTIVE_WPM);
const WORD_BAND_V2 = [Math.round(WORD_BUDGET * 0.8), Math.round(WORD_BUDGET * 1.15)];
const INTRO_FRacT = 0.10, RECAP_FRacT = 0.10; // reserved for intro + conclusion
const MAX_REVISION_CYCLES = Number(process.env.COURSE_REVISION_CYCLES || 2);

const wordCount = (parsed) =>
  (parsed.segments || []).reduce((n, s) => n + String(s.text).split(/\s+/).filter(Boolean).length, 0);

// ---- Phase 1: layered content classification -------------------------------
// Categories: admin | references | exercise | intro_admin |
//             math | example | application | concept | support | mixed
export const SECTION_KIND = Object.freeze([
  'admin', 'references', 'exercise', 'concept', 'support', 'math', 'example', 'application', 'mixed',
]);

const ADMIN_TITLE_RE = /\b(syllabus|grading|grade|office hours?|contact|instructor|teaching assistant|course (policy|policies|administration|logistics|structure)|schedule|deadline|attendance|academic (integrity|honesty|regulation)|plagiarism|exam dates?|midterm|final exam|registration|textbook|prerequisite|learning (outcomes?|objectives of the course)|about (this|the) course|welcome|introduction to the course|course overview|course information)\b/i;
const REFS_TITLE_RE = /\b(references|bibliography|further reading|works cited|acknowledg(e)?ments?)\b/i;
const EXERCISE_TITLE_RE = /\b(exercise|problem set|homework|quiz|review questions?|check all that apply|worksheet)\b/i;

// Exercises/references can sit mid-document in otherwise teaching sections —
// score body text, not just titles.
const EXERCISE_BODY_RE = /\b(exercise|question|problem|check all that apply|select the correct|what is the correct|fill in the blank|your task|challenge)\b/i;
const MATH_BODY_RE = /\b(theorem|lemma|proof|derive|determinant|eigenvalue|derivative|integral|∇|∂|σ|λ|∑|matrix|gradient|variance|covariance)\b/i;
const EXAMPLE_BODY_RE = /\b(example|for instance|suppose|consider|scenario|case study|e\.g\.)\b/i;
const APP_BODY_RE = /\b(application|used in|applied to|real[- ]world|industry|domain|deployment|in practice)\b/i;
const DEF_BODY_RE = /\b(definition|is defined as|refers to|is a|are a|means that|we call)\b/i;

export function classifySection({ title, summary, text }) {
  const head = `${title || ''}\n${summary || ''}`;
  const body = String(text || '').slice(0, 4000);
  // Layer 1 — deterministic title/context rules (highest confidence).
  if (ADMIN_TITLE_RE.test(head) || isAdminText(head)) return { kind: 'admin', confidence: 'high', reason: 'admin title/summary' };
  if (REFS_TITLE_RE.test(head)) return { kind: 'references', confidence: 'high', reason: 'references heading' };
  if (EXERCISE_TITLE_RE.test(head)) return { kind: 'exercise', confidence: 'high', reason: 'exercise heading' };
  // Layer 2 — body heuristics: an admin-DOMINATED body is still admin even
  // when the title is innocuous ("Overview", "Introduction").
  if (isAdminText(body)) return { kind: 'admin', confidence: 'medium', reason: 'admin-heavy body' };
  // Layer 3 — kind detection for educational sections.
  const hits = (re) => (body.match(new RegExp(re.source, 'gi')) || []).length;
  const w = body.split(/\s+/).filter(Boolean).length;
  if (w < 8) return { kind: 'mixed', confidence: 'low', reason: 'too little text' };
  const scores = {
    exercise: hits(EXERCISE_BODY_RE),
    math: hits(MATH_BODY_RE),
    example: hits(EXAMPLE_BODY_RE),
    application: hits(APP_BODY_RE),
    concept: hits(DEF_BODY_RE),
  };
  if (scores.exercise >= 2 && scores.exercise >= Math.max(scores.concept, scores.example)) {
    return { kind: 'exercise', confidence: 'medium', reason: 'exercise-heavy body' };
  }
  const top = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  if (top[1] >= 2) return { kind: top[0], confidence: 'medium', reason: `${top[0]} markers ×${top[1]}` };
  return { kind: 'concept', confidence: 'low', reason: 'default teaching content' };
}

// Narration-evidence eligibility: which kinds feed the writer.
export const EVIDENCE_KINDS = new Set(['concept', 'support', 'math', 'example', 'application', 'mixed']);
export const EXCLUDED_KINDS = new Set(['admin', 'references', 'exercise']);

// Optional semantic fallback — injected in production only; tests pass mocks.
export async function classifyAmbiguous(sections, deps) {
  const chat = deps.chat || defaultChat;
  const amb = sections.filter((s) => s._class.confidence === 'low');
  if (!amb.length) return sections;
  try {
    const out = await chat([
      { role: 'system', content:
        `Classify each lecture-section title for a narration-evidence filter. ` +
        `Return JSON {"kinds":["educational"|"admin"|"references"|"exercise"]} ` +
        `— one entry per listed section, in order.` },
      { role: 'user', content: amb.map((s, i) => `${i + 1}. "${s.title}"`).join('\n') },
    ], { json: true, maxTokens: 300 });
    (out?.kinds || []).forEach((k, i) => {
      if (amb[i] && typeof k === 'string') {
        if (k === 'admin' || k === 'references' || k === 'exercise') {
          amb[i]._class = { kind: k, confidence: 'semantic', reason: 'llm classifier' };
        }
      }
    });
  } catch { /* ambiguous stays educational — it may still be filtered later */ }
  return sections;
}

// ---- Phase 2: topic inventory (structured document traversal) --------------
// Traverses assigned page ranges in ORDER — every teaching section is a
// candidate topic, so early/middle/late content is all considered. Vector
// similarity is reserved for evidence excerpts, not coverage.
export async function buildTopicInventory(courseId, outlineEntry, deps = {}) {
  const docIds = (outlineEntry.sources || []).map((s) => s.documentId).filter(Boolean);
  let secRows, chunks;
  if (deps.sections && deps.chunks) {
    // Test seam — caller supplies rows shaped like course_sections/chunks.
    secRows = deps.sections; chunks = deps.chunks;
  } else {
    const pool = getPool();
    ({ rows: secRows } = await pool.query(
      `SELECT s.id, s.title, s.summary, s.page_start, s.page_end, s.idx,
              d.filename, d.id AS document_id
         FROM course_sections s JOIN course_documents d ON d.id = s.document_id
        WHERE s.course_id = $1 AND ($2::uuid[] IS NULL OR s.document_id = ANY($2::uuid[]))
        ORDER BY d.filename, s.page_start, s.idx`, [courseId, docIds.length ? docIds : null]));
    // Chunk text per section for classification + evidence excerpts.
    ({ rows: chunks } = await pool.query(
      `SELECT c.id, c.section_id, c.heading, c.text, c.page, d.filename, d.id AS document_id
         FROM course_chunks c JOIN course_documents d ON d.id = c.document_id
        WHERE c.course_id = $1 AND ($2::uuid[] IS NULL OR c.document_id = ANY($2::uuid[]))
        ORDER BY c.page, c.idx`, [courseId, docIds.length ? docIds : null]));
  }
  const chunksBySection = new Map();
  for (const c of chunks) {
    if (!chunksBySection.has(c.section_id)) chunksBySection.set(c.section_id, []);
    chunksBySection.get(c.section_id).push(c);
  }

  const inRange = (s, ranges) => ranges?.length
    ? ranges.some(([a, b]) => s.page_start <= b && s.page_end >= a) : true;
  const rangeByDoc = Object.fromEntries((outlineEntry.sources || [])
    .map((s) => [s.documentId, s.pages]));

  const unprocessedPages = [];
  const excluded = [];
  const seenTitles = new Set();
  const inventory = [];
  for (const s of secRows) {
    const ranges = rangeByDoc[s.document_id];
    if (!inRange(s, ranges)) { unprocessedPages.push(`${s.filename}:${s.page_start}-${s.page_end}`); continue; }
    const sChunks = chunksBySection.get(s.id) || [];
    const text = sChunks.map((c) => c.text).join(' ');
    const cls = classifySection({ title: s.title, summary: s.summary, text });
    const sec = { ...s, chunkIds: sChunks.map((c) => c.id), wordLen: text.split(/\s+/).filter(Boolean).length, _class: cls, _text: text };
    if (EXCLUDED_KINDS.has(cls.kind)) { excluded.push(sec); continue; }
    const dedupeKey = s.title.trim().toLowerCase();
    if (seenTitles.has(dedupeKey) && sec.wordLen < 60) continue; // tiny repeated label → skip
    seenTitles.add(dedupeKey);
    inventory.push(sec);
  }

  // Optional LLM pass on low-confidence labels only.
  const withSem = await classifyAmbiguous(inventory, deps);
  const teaching = withSem.filter((s) => EVIDENCE_KINDS.has(s._class.kind));

  // Importance heuristic — deterministic, explainable:
  //   +3 title implies core concept (definition/how/what/why/model/algorithm)
  //   +2 'math'/'concept' kind; +1 'example'/'application'
  //   +1 section has ≥150 words of material;  -1 wordLen < 60 (thin fragment)
  const coreTitle = /\b(definition|what is|how|why|model|algorithm|method|function|regression|classification|clustering|loss|cost|gradient|theorem|inference|prediction)\b/i;
  const score = (s) =>
    (coreTitle.test(s.title) ? 3 : 0) +
    (s._class.kind === 'math' || s._class.kind === 'concept' ? 2 : 0) +
    (s._class.kind === 'example' || s._class.kind === 'application' ? 1 : 0) +
    (s.wordLen >= 150 ? 1 : 0) - (s.wordLen < 60 ? 1 : 0);

  const topics = teaching.map((s, i) => ({
    id: `topic${i + 1}`,
    title: s.title,
    description: (s.summary || s._text.slice(0, 400)).trim(),
    keyConcepts: extractConcepts(s),
    source: { documentId: s.document_id, filename: s.filename, pageStart: s.page_start, pageEnd: s.page_end },
    importance: score(s) >= 4 ? 'essential' : score(s) >= 2 ? 'supporting' : 'optional',
    importanceScore: score(s),
    examples: s._class.kind === 'example' || s._class.kind === 'application' ? [s.title] : [],
    prerequisites: [],
    sectionId: s.id,
    chunkIds: s.chunkIds,
    kind: s._class.kind,
  }));
  const allExcluded = [...excluded,
    ...withSem.filter((s) => !EVIDENCE_KINDS.has(s._class.kind))];
  return { topics, excluded: allExcluded
      .map((s) => ({ title: s.title, filename: s.filename, pages: [s.page_start, s.page_end], kind: s._class.kind, reason: s._class.reason })),
    unprocessedPages };
}

export function extractConcepts(section) {
  // Cheap key-phrase extraction: capitalized/technical n-grams from summary+text.
  const src = `${section.summary || ''} ${String(section._text || '').slice(0, 1200)}`;
  const terms = new Set();
  for (const m of src.matchAll(/\b([a-z][a-z-]+(?:\s+[a-z-]+){0,2})\b/gi)) {
    const t = m[1].toLowerCase();
    if (t.length > 4 && !/^(the|this|that|with|from|into|have|will|your|them|when|then|also|such|only|each|very|more|some|many|here|what|where|which|these|those|there|they|does|because|through|between|about|after|before|chapter|section|page|figure|slide)\b/.test(t)) {
      terms.add(t);
      if (terms.size >= 8) break;
    }
  }
  return [...terms];
}

// ---- Phase 2b: teaching plan ------------------------------------------------
// Deterministic budget allocation — the word ceiling is enforced HERE, in
// the plan, not by deleting output later.
export function buildTeachingPlan(outlineEntry, inventory, { minutes = TARGET_MINUTES, wpm = EFFECTIVE_WPM } = {}) {
  const total = Math.round(minutes * wpm);
  const intro = Math.round(total * INTRO_FRacT);
  const recap = Math.round(total * RECAP_FRacT);
  const body = total - intro - recap;
  const minTopic = 45; // below ~45 spoken words a topic can't be explained

  // Rank: importance first, then source order (stable sort preserves doc order).
  const order = ['essential', 'supporting', 'optional'];
  const ranked = [...inventory.topics].sort((a, b) =>
    order.indexOf(a.importance) - order.indexOf(b.importance)
    || inventory.topics.indexOf(a) - inventory.topics.indexOf(b));

  const weight = (t) => ({ essential: 3, supporting: 2, optional: 1 }[t.importance]);
  const included = [], omitted = [];
  let remaining = body;
  for (const t of ranked) {
    // Provisional proportional share.
    const share = Math.floor(body * weight(t) / Math.max(1, ranked.reduce((n, x) => n + weight(x), 0)));
    const alloc = Math.max(minTopic, share);
    if (remaining >= alloc) { included.push({ ...t, budget: alloc }); remaining -= alloc; }
    else omitted.push({ id: t.id, title: t.title, importance: t.importance, reason: 'word budget exhausted' });
  }
  // Re-order included topics back into source order for narration coherence.
  included.sort((a, b) => inventory.topics.indexOf(a) - inventory.topics.indexOf(b));
  const plan = {
    objective: outlineEntry.title,
    minutes, wpm, wordBudget: total, bodyBudget: body,
    introWords: intro, recapWords: recap,
    topics: included.map(({ importanceScore, ...t }) => t),
    omitted,
    structure: [
      { role: 'introduction', words: intro },
      ...included.map((t) => ({ role: 'topic', topicId: t.id, title: t.title, words: t.budget, importance: t.importance, source: t.source })),
      { role: 'conclusion', words: recap },
    ],
  };
  return plan;
}

// ---- Phase 3: narration -----------------------------------------------------
// Evidence = the FULL assigned chunks per included topic (document order),
// not a similarity top-k sample — coverage comes from traversal.
export async function evidenceForTopics(courseId, plan, deps = {}) {
  if (deps.evidence) return deps.evidence;
  const pool = getPool();
  const planChunks = [];
  for (const t of plan.topics) {
    if (!t.chunkIds?.length) continue;
    const { rows } = await pool.query(
      `SELECT c.text, c.page, c.heading, d.filename, c.document_id
         FROM course_chunks c JOIN course_documents d ON d.id = c.document_id
        WHERE c.id = ANY($1::uuid[]) ORDER BY c.page, c.idx`, [t.chunkIds]);
    const usable = rows.filter((r) => !isAdminText(r.text));
    planChunks.push({ topic: t, chunks: usable });
  }
  return planChunks;
}

export function buildEvidenceContext(planChunks) {
  const blocks = [];
  for (const { topic, chunks } of planChunks) {
    blocks.push(
      `### Topic "${topic.title}" — ~${topic.budget} spoken words — ` +
      `importance: ${topic.importance}\n` +
      chunks.map((c) =>
        `[src] ${c.filename} page ${c.page ?? '?'}\n${String(c.text).slice(0, 1500)}`
      ).join('\n\n'));
  }
  return blocks.join('\n\n');
}

async function writeNarration(outlineEntry, plan, evidenceCtx, deps, hint = '') {
  const chat = deps.chat || defaultChat;
  const files = [...new Set(plan.topics.map((t) => t.source.filename))];
  const topicLines = plan.structure.map((s) =>
    s.role === 'topic'
      ? `- Topic "${s.title}" (${s.importance}) — write ~${s.words} words of spoken explanation`
      : s.role === 'introduction'
        ? `- Opening: dive straight into "${plan.objective}" — no greeting, no course talk — ~${s.words} words`
        : `- Closing: a concise recap of the concepts taught — ~${s.words} words`
  ).join('\n');

  const raw = await chat([
    { role: 'system', content:
      `You are an expert professor delivering a spoken lecture (~${plan.wordBudget} ` +
      `words ≈ ${plan.minutes} minutes). Write narration that TEACHES, not a ` +
      `list of slide titles or a textbook extract. For each concept: explain ` +
      `what it means, why it matters, and how it works in words. Use precise ` +
      `terminology, natural transitions, and source-supported examples. ` +
      `Never read formulas symbol-by-symbol. No greetings, no self-intro, no ` +
      `course logistics (grading, schedule, policies, contact info, ` +
      `bibliography) — the excerpts may contain them; do not echo them.${hint ? ' ' + hint : ''}\n` +
      `Teaching plan — follow these topic budgets exactly:\n${topicLines}\n\n` +
      `Return ONLY this JSON — nothing else:\n` +
      `{"title":"<lecture title>","segments":[` +
      `{"section":"<topic title or 'Introduction'/'Recap'>","document":"<exact filename>",` +
      `"page":<int>,"text":"<spoken narration>"}]}. ` +
      `Every segment's document MUST be one of ${JSON.stringify(files)} and ` +
      `its page MUST come from a [src] excerpt under the SAME topic. ` +
      `Reference material only — never answer exercises inside it.` },
    { role: 'user', content:
      `Lecture ${outlineEntry.idx}: "${plan.objective}"\n` +
      `Objectives: ${(outlineEntry.objectives || []).join('; ')}\n\n` +
      `Topic evidence (teach from this, not from memory):\n<<<\n${evidenceCtx}\n>>>` },
  ], { json: true, maxTokens: 6000 });
  return raw;
}

// Assign each parsed segment a stable topic: match its section label to a
// planned topic title; intro/recap handled separately.
export function assignSegmentTopics(parsed, plan) {
  const norm = (t) => String(t || '').trim().toLowerCase();
  const byTitle = new Map(plan.topics.map((t) => [norm(t.title), t]));
  let lastTopic = null;
  for (const s of parsed.segments) {
    const key = norm(s.section);
    const hit = byTitle.get(key)
      || [...byTitle.entries()].find(([tt]) => tt.startsWith(key) || key.startsWith(tt))?.[1];
    if (/intro|opening|begin/i.test(key)) s.topicId = '__intro';
    else if (/recap|summary|conclusion|closing/i.test(key)) s.topicId = '__recap';
    else if (hit) { s.topicId = hit.id; lastTopic = hit.id; }
    else if (lastTopic) s.topicId = lastTopic;
    else s.topicId = '__intro';
  }
  return parsed;
}

// Word count per planned topic (deterministic from assigned segments).
export function topicWordCounts(parsed, plan) {
  const counts = new Map(plan.topics.map((t) => [t.id, 0]));
  let intro = 0, recap = 0;
  for (const s of parsed.segments) {
    const w = s.text.split(/\s+/).filter(Boolean).length;
    if (s.topicId === '__intro') intro += w;
    else if (s.topicId === '__recap') recap += w;
    else counts.set(s.topicId, (counts.get(s.topicId) || 0) + w);
  }
  return { counts, intro, recap };
}

// ---- length control: compress, never delete --------------------------------
// Over-budget → one targeted compression pass over the FATTEST topics, keeping
// all concepts. Still over → validation fails with a clear reason.
export async function compressOvershoot(parsed, plan, evidenceCtx, deps) {
  const chat = deps.chat || defaultChat;
  const { counts } = topicWordCounts(parsed, plan);
  const over = plan.topics.filter((t) => (counts.get(t.id) || 0) > Math.round(t.budget * 1.4));
  const target = over.length ? over : plan.topics;
  const segs = parsed.segments.filter((s) => target.some((t) => t.id === s.topicId));
  if (!segs.length) return parsed;
  try {
    const out = await chat([
      { role: 'system', content:
        `Tighten these spoken-lecture segments to ~70% of their length. Keep ` +
        `every concept, keep provenance fields unchanged, keep it teachable. ` +
        `Return JSON {"segments":[{"id":<int>,"text":"..."}]} — only revised entries.` },
      { role: 'user', content:
        segs.map((s) => `{"id":${s.id},"section":${JSON.stringify(s.section)},"document":${JSON.stringify(s.document)},"page":${s.page},"text":${JSON.stringify(s.text)}}`).join('\n') },
    ], { json: true, maxTokens: 4000 });
    const edits = new Map((out?.segments || []).map((x) => [x.id, x.text]));
    for (const s of parsed.segments) {
      const t = edits.get(s.id);
      if (t && String(t).split(/\s+/).filter(Boolean).length < s.text.split(/\s+/).filter(Boolean).length) {
        s.text = String(t).replace(/\s{2,}/g, ' ').trim();
      }
    }
  } catch { /* unchanged — validation will report the overflow */ }
  parsed.sections = segsToSections(parsed.segments);
  return parsed;
}

// ---- Phase 4: structured critic → targeted revision -------------------------
export async function critique(parsed, plan, deps) {
  const chat = deps.chat || defaultChat;
  const segLines = parsed.segments.map((s) =>
    `#${s.id} [${s.section}] (p${s.page}, ${s.document}): ${s.text}`).join('\n');
  const planned = plan.topics.map((t) => `${t.id} "${t.title}" (${t.importance}, ~${t.budget}w)`).join('; ');
  const out = await chat([
    { role: 'system', content:
      `You are a strict teaching-quality critic. Evaluate a lecture script against ` +
      `its teaching plan. Return JSON {"findings":[{"segment":<int|null>,"problem":"...",` +
      `"severity":"high|medium|low","action":"what the writer must change","topicId":"topicN|null"}]}. ` +
      `Check: essential topics actually EXPLAINED (not merely named); ` +
      `factual accuracy vs source scope; grounding (no invented numbers/facts); ` +
      `explanatory depth; logical order and transitions; repetition; any ` +
      `administrative/course-logistics leakage; unexplained jargon. ` +
      `Be surgical — one finding per real defect; return [] if good.` },
    { role: 'user', content:
      `Lecture objective: ${plan.objective}\nPlanned topics: ${planned}\n\nScript:\n${segLines}` },
  ], { json: true, maxTokens: 1500 });
  const findings = (out?.findings || [])
    .filter((f) => f && (f.problem || f.action))
    .slice(0, 8);
  return { findings };
}

export async function revise(parsed, findings, plan, evidenceCtx, deps) {
  const chat = deps.chat || defaultChat;
  const targeted = findings.map((f, i) =>
    `Finding ${i + 1}${f.segment != null ? ` (segment ${f.segment})` : ''}${f.topicId ? ` [${f.topicId}]` : ''}: ${f.problem} → ${f.action}`).join('\n');
  const raw = await chat([
    { role: 'system', content:
      `Revise this lecture script minimally — fix ONLY the findings below; keep ` +
      `everything else identical, preserve section/document/page fields and ` +
      `transitions. Return the SAME full JSON shape {"title","segments":[...]}.` },
    { role: 'user', content:
      `Findings:\n${targeted}\n\nCurrent script:\n${JSON.stringify({ title: parsed.title, segments: parsed.segments }).slice(0, 12000)}` },
  ], { json: true, maxTokens: 6000 });
  const next = parseSegments(raw);
  if (next.segments.length >= parsed.segments.length * 0.8) return next;
  return parsed; // revision gutted the script — keep the original
}

// ---- validation --------------------------------------------------------------
// V2: everything V1 checks PLUS — intro must not be admin, essential topics
// must have narration, word band is the PLAN budget (not a global guess).
export function validateLectureV2(parsed, allowedDocs, plan) {
  const problems = [];
  const words = wordCount(parsed);
  if (parsed.title === 'Untitled lecture') problems.push('missing title');
  if (parsed.segments.length < 4) problems.push(`too few segments (${parsed.segments.length})`);
  for (const [i, s] of parsed.segments.entries()) {
    const w = s.text.split(/\s+/).filter(Boolean).length;
    if (w < 15) problems.push(`segment ${i + 1} is a fragment, not narration`);
    const src = allowedDocs?.[s.document];
    if (allowedDocs && !src) problems.push(`segment ${i + 1}: unassigned document "${s.document}"`);
    else if (src && s.page == null) problems.push(`segment ${i + 1}: missing page`);
    else if (src && !src.pages.some(([a, b]) => s.page >= a && s.page <= b)) {
      problems.push(`segment ${i + 1}: page ${s.page} outside assigned ranges of "${s.document}"`);
    }
  }
  if (words < WORD_BAND_V2[0]) problems.push(`too short (${words} words < ${WORD_BAND_V2[0]} for ~${Math.round(plan?.wordBudget || WORD_BUDGET)}w target)`);
  if (words > WORD_BAND_V2[1]) problems.push(`too long (${words} words > ${WORD_BAND_V2[1]} for ~${Math.round(plan?.wordBudget || WORD_BUDGET)}w target)`);
  // Admin leak: FIRST segment must be subject matter — no course logistics
  // opening, ever.
  for (const [i, s] of parsed.segments.slice(0, 2).entries()) {
    if (ADMIN_NARRATION.test(s.text) || ADMIN_TITLE_RE.test(s.section)) {
      problems.push(`segment ${i + 1} opens on administrative/course-logistics content`);
    }
  }
  for (const [i, sec] of (parsed.sections || []).entries()) {
    const hits = sec.segments.filter((s) => ADMIN_NARRATION.test(s.text)).length;
    if (hits >= Math.max(1, Math.floor(sec.segments.length / 2))) {
      problems.push(`section ${i + 1} narrates course admin, not the subject`);
    }
  }
  // Essential topics must be narrated — plan coverage is enforced, not implied.
  if (plan?.topics?.length) {
    const { counts } = topicWordCounts(parsed, plan);
    for (const t of plan.topics) {
      if (t.importance === 'essential' && (counts.get(t.id) || 0) < 30) {
        problems.push(`essential topic "${t.title}" has <30 words — named but not explained`);
      }
    }
  }
  return { ok: !problems.length, problems, words };
}

// ---- orchestration ------------------------------------------------------------
export async function generateLectureV2(courseId, outlineEntry, deps = {}) {
  const meta = { version: GENERATOR_VERSION, promptVersion: PROMPT_VERSION,
    model: process.env.COURSE_LLM_MODEL || 'qwen3:8b', targetMinutes: TARGET_MINUTES,
    effectiveWpm: EFFECTIVE_WPM, wordBudget: WORD_BUDGET, llmCalls: 0, startedAt: Date.now() };
  const countedChat = async (...a) => { meta.llmCalls += 1; return (deps.chat || defaultChat)(...a); };
  const myDeps = { ...deps, chat: countedChat };

  const allowedDocs = Object.fromEntries((outlineEntry.sources || [])
    .map((s) => [s.filename, { documentId: s.documentId, pages: s.pages }]));

  // Phase 1+2: classified inventory + teaching plan.
  const inventory = await buildTopicInventory(courseId, outlineEntry, myDeps);
  const plan = buildTeachingPlan(outlineEntry, inventory, {});
  if (!plan.topics.length) {
    throw new Error(`No educational topics for "${outlineEntry.title}" — source appears administrative-only`);
  }
  const evidenceChunks = await evidenceForTopics(courseId, plan, deps);
  const evidenceCtx = buildEvidenceContext(evidenceChunks);
  if (!evidenceCtx.trim()) throw new Error(`No usable evidence text for "${outlineEntry.title}"`);

  // Phase 3: narration (≤2 writes) — then compression control, never trim.
  let parsed = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await writeNarration(outlineEntry, plan, evidenceCtx, myDeps, attempt ? 'Keep it tight; the last draft missed the budget.' : '');
    const cand = parseSegments(raw);
    if (!cand.segments.length) { console.error('[v2] unparseable script head:', JSON.stringify(raw)?.slice(0, 300)); continue; }
    parsed = assignSegmentTopics(cand, plan);
    parsed.sections = segsToSections(parsed.segments);
    let v = validateLectureV2(parsed, allowedDocs, plan);
    if (!v.ok && v.problems.some((p) => p.startsWith('too long'))) {
      parsed = await compressOvershoot(parsed, plan, evidenceCtx, myDeps);
      v = validateLectureV2(parsed, allowedDocs, plan);
    }
    if (v.ok || attempt === 1) { parsed.validation = v.ok ? undefined : { ok: false, problems: v.problems }; break; }
    console.log(`[v2] lecture ${outlineEntry.idx} attempt ${attempt + 1} rejected: ${v.problems.join(', ')}`);
  }
  if (!parsed) throw new Error('LLM produced no usable script');

  // Phase 4: bounded critic → targeted revision.
  let revisions = 0;
  for (; revisions < MAX_REVISION_CYCLES; revisions++) {
    const { findings } = await critique(parsed, plan, myDeps).catch(() => ({ findings: [] }));
    if (!findings.length) break;
    const revised = await revise(parsed, findings, plan, evidenceCtx, myDeps);
    const next = assignSegmentTopics(revised, plan);
    next.sections = segsToSections(next.segments);
    const v = validateLectureV2(next, allowedDocs, plan);
    if (v.ok || wordCount(next) <= WORD_BAND_V2[1]) parsed = next;
    else { parsed = next; break; }
  }
  meta.revisionCycles = revisions;

  // Final gate — never silently publish a damaged script.
  const final = validateLectureV2(parsed, allowedDocs, plan);
  parsed.validation = final.ok ? undefined : { ok: false, problems: final.problems };
  if (parsed.title === 'Untitled lecture') parsed.title = outlineEntry.title;
  parsed.wordCount = wordCount(parsed);
  parsed.estimatedMinutes = parsed.wordCount / EFFECTIVE_WPM;
  parsed.plan = plan;
  parsed.inventorySummary = {
    totalTopics: inventory.topics.length,
    included: plan.topics.map((t) => t.id),
    omitted: plan.omitted,
    excluded: inventory.excluded,
    unprocessedPages: inventory.unprocessedPages,
  };
  meta.wordCount = parsed.wordCount;
  meta.estimatedMinutes = parsed.estimatedMinutes;
  meta.elapsedMs = Date.now() - meta.startedAt;
  parsed.genMeta = meta;
  return parsed;
}

// ---- eval records -------------------------------------------------------------
// Appends a per-lecture evaluation record — JSON next to the artifacts +
// one CSV row under eval/records/ for cross-run comparison.
export async function recordEval(courseId, outlineEntry, lecture, { genMeta = null } = {}) {
  const rec = {
    at: new Date().toISOString(),
    generatorVersion: GENERATOR_VERSION,
    promptVersion: PROMPT_VERSION,
    model: genMeta?.model || process.env.COURSE_LLM_MODEL || 'qwen3:8b',
    courseId,
    lecture: outlineEntry.title,
    wordCount: lecture.wordCount,
    estimatedMinutes: lecture.estimatedMinutes,
    llmCalls: genMeta?.llmCalls ?? null,
    revisionCycles: genMeta?.revisionCycles ?? null,
    elapsedMs: genMeta?.elapsedMs ?? null,
    validation: lecture.validation || { ok: true },
    provenance: {
      total: lecture.segments.length,
      withDoc: lecture.segments.filter((s) => s.documentId || s.document).length,
      withPage: lecture.segments.filter((s) => s.page != null).length,
    },
    adminLeakSegments: lecture.segments.filter((s) => ADMIN_NARRATION.test(s.text)).length,
    plan: {
      objective: lecture.plan?.objective,
      topics: (lecture.plan?.topics || []).map((t) => ({ id: t.id, title: t.title, importance: t.importance, budget: t.budget })),
      omitted: lecture.plan?.omitted || [],
      excludedSections: lecture.inventorySummary?.excluded?.map((x) => `${x.filename}:${x.title}`) || [],
      unprocessedPages: lecture.inventorySummary?.unprocessedPages || [],
    },
  };
  try {
    await fsp.mkdir(EVAL_DIR, { recursive: true });
    const lid = `gen_${courseId.slice(0, 8)}_L${outlineEntry.idx}`;
    await fsp.writeFile(path.join(EVAL_DIR, `${lid}_${GENERATOR_VERSION}.json`), JSON.stringify(rec, null, 2));
    const csvLine = [rec.at, rec.generatorVersion, rec.model, courseId.slice(0, 8),
      outlineEntry.idx, JSON.stringify(outlineEntry.title).replace(/,/g, ';'),
      rec.wordCount, rec.estimatedMinutes?.toFixed?.(1), rec.llmCalls, rec.revisionCycles,
      rec.elapsedMs, rec.validation.ok ? 'ok' : 'FAIL', rec.provenance.withDoc,
      rec.provenance.withPage, rec.adminLeakSegments].join(',');
    const csvPath = path.join(EVAL_DIR, 'records.csv');
    if (!existsSync(csvPath)) {
      await fsp.writeFile(csvPath, 'at,version,model,course,idx,title,words,estMin,llmCalls,revisions,elapsedMs,validation,segsWithDoc,segsWithPage,adminLeak\n');
    }
    await fsp.appendFile(csvPath, csvLine + '\n');
  } catch (e) {
    console.warn('[eval] record write failed:', e.message);
  }
  return rec;
}
