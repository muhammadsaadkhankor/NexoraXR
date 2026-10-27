// Lecture script generator V3 — pedagogically-sequenced, batch-written
// professor narration.
//
//   source sections → classify (V2 rules + course-description detection) →
//   SEMANTIC CONCEPT MAP (one LLM call: primary subject, concepts with
//     roles core/supporting/example/prerequisite, dependencies, omissions) →
//   TEACHING PLAN (dependency-ordered, deduplicated, per-block budgets,
//     transition intentions, examples bound to their concept) →
//   BATCHED NARRATION (one focused write per plan block; each call sees its
//     evidence, its budget, the prior ending, the next objective, and the
//     terms already introduced) →
//   DETERMINISTIC CHECKS (repetition, admin leak, provenance) +
//   STRUCTURED CRITIC (six dimensions, actionable findings) →
//   TARGETED REVISION (≤2 cycles) → LENGTH CONTROL (compress over-budget
//     blocks; NEVER delete trailing segments) → FINAL VALIDATION.
//
// V1 and V2 stay intact. Selection: COURSE_GENERATOR=v1|v2|v3 (default v3).

import path from 'node:path';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { existsSync, createReadStream } from 'node:fs';
import { getPool } from '../db/pool.mjs';
import { chat as defaultChat } from './llm.mjs';
import { parseSegments, segsToSections } from './generator.mjs';
import { classifySection as classifyV2, EVIDENCE_KINDS, EXCLUDED_KINDS } from './generator2.mjs';
import { isAdminText, ADMIN_NARRATION } from './admin.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const EVAL_DIR = path.join(REPO_ROOT, 'eval', 'records');
const MATERIALS_DIR = path.join(REPO_ROOT, 'src', 'nexora_server', 'uploads', 'materials');

export const GENERATOR_VERSION = 'v3.1';
export const PROMPT_VERSION = 'v3-blocks-2026-10-26';

// Duration: 5–10 min configurable; default 7. WPM calibrated on measured
// VoxCPM output (65–80 wpm) — NOT a generic 130 wpm.
export const TARGET_MINUTES = Math.min(10, Math.max(5, Number(process.env.COURSE_TARGET_MINUTES || 7)));
export const EFFECTIVE_WPM = Math.min(130, Math.max(50, Number(process.env.COURSE_EFFECTIVE_WPM || 72)));
const WORD_BUDGET = Math.round(TARGET_MINUTES * EFFECTIVE_WPM);
// Upper bound = the configured 10-minute ceiling (TARGET*WPM at 10min), not a
// narrow ±15% around the target — a 5–10min lecture is compliant anywhere in
// that band.
const WORD_BAND = [Math.round(WORD_BUDGET * 0.8), Math.round(Math.min(WORD_BUDGET * 1.4, 10 * EFFECTIVE_WPM))];
const INTRO_FRacT = 0.10, RECAP_FRacT = 0.10;
const MAX_REVISION_CYCLES = Number(process.env.COURSE_REVISION_CYCLES || 2);
const MAX_PLAN_RETRIES = 2;

const wordCount = (parsed) =>
  (parsed.segments || []).reduce((n, s) => n + String(s.text).split(/\s+/).filter(Boolean).length, 0);

// ---- Phase 1: classification (V2 + course-description extension) ------------
// V2 root cause: "This course combines ML theory, coding, and projects" passed
// the filter — it is course DESCRIPTION, not policy. Extend detection.
const COURSE_DESC_RE = /\b(this course|the course|in this course|our course|why this course|course covers|course focuses|course combines|course aims|about the course|why take|who should take|course materials?|course description)\b/i;

export function classifySectionV3({ title, summary, text }) {
  const head = `${title || ''}\n${summary || ''}`;
  if (COURSE_DESC_RE.test(head)) {
    return { kind: 'admin', confidence: 'high', reason: 'course-description title' };
  }
  const base = classifyV2({ title, summary, text });
  if (base.kind !== 'admin' && base.confidence !== 'high') {
    // Body-level course description: multiple "this course" markers.
    const hits = (String(text || '').match(new RegExp(COURSE_DESC_RE.source, 'gi')) || []).length;
    if (hits >= 2) return { kind: 'admin', confidence: 'medium', reason: 'course-description body' };
  }
  return base;
}

// ---- source corpus ----------------------------------------------------------
// Same shape as V2's inventory, but every section also carries its text for
// the semantic planner. deps.sections/deps.chunks = test seam.
export async function loadCorpus(courseId, outlineEntry, deps) {
  const docIds = (outlineEntry.sources || []).map((s) => s.documentId).filter(Boolean);
  let secRows, chunks;
  if (deps.sections && deps.chunks) {
    secRows = deps.sections; chunks = deps.chunks;
  } else {
    const pool = getPool();
    ({ rows: secRows } = await pool.query(
      `SELECT s.id, s.title, s.summary, s.page_start, s.page_end, s.idx,
              d.filename, d.id AS document_id
         FROM course_sections s JOIN course_documents d ON d.id = s.document_id
        WHERE s.course_id=$1 AND ($2::uuid[] IS NULL OR s.document_id = ANY($2::uuid[]))
        ORDER BY d.filename, s.page_start, s.idx`, [courseId, docIds.length ? docIds : null]));
    ({ rows: chunks } = await pool.query(
      `SELECT c.id, c.section_id, c.heading, c.text, c.page, d.filename, d.id AS document_id
         FROM course_chunks c JOIN course_documents d ON d.id = c.document_id
        WHERE c.course_id=$1 AND ($2::uuid[] IS NULL OR c.document_id = ANY($2::uuid[]))
        ORDER BY c.page, c.idx`, [courseId, docIds.length ? docIds : null]));
  }
  const rangeByDoc = Object.fromEntries((outlineEntry.sources || [])
    .map((s) => [s.documentId, s.pages]));
  const inRange = (s) => !rangeByDoc[s.document_id]?.length ||
    rangeByDoc[s.document_id].some(([a, b]) => s.page_start <= b && s.page_end >= a);
  const chunksBySection = new Map();
  for (const c of chunks) {
    if (!chunksBySection.has(c.section_id)) chunksBySection.set(c.section_id, []);
    chunksBySection.get(c.section_id).push(c);
  }
  const unprocessedPages = [];
  const excluded = [];
  const teaching = [];
  for (const s of secRows) {
    if (!inRange(s)) { unprocessedPages.push(`${s.filename}:${s.page_start}-${s.page_end}`); continue; }
    const sChunks = (chunksBySection.get(s.id) || []).filter((c) => !isAdminText(c.text));
    const text = sChunks.map((c) => c.text).join(' ');
    const cls = classifySectionV3({ title: s.title, summary: s.summary, text });
    const rec = { ...s, chunks: sChunks, text, _class: cls };
    if (EXCLUDED_KINDS.has(cls.kind)) excluded.push(rec); else teaching.push(rec);
  }
  return { teaching, excluded, unprocessedPages };
}

// ---- Phase 2: semantic concept map ------------------------------------------
// One LLM call over section titles+summaries produces the CONCEPTUAL map —
// the model reads the whole section index, not raw pages, so qwen3:8b can
// handle it. Source refs are resolved back deterministically afterwards.
export async function buildConceptMap(outlineEntry, corpus, deps) {
  const chat = deps.chat || defaultChat;
  const catalog = corpus.teaching.map((s, i) =>
    `[S${i}] "${s.title}" (${s.filename} pp.${s.page_start}-${s.page_end}): ` +
    `${(s.summary || s.text.slice(0, 220)).replace(/\s+/g, ' ').slice(0, 220)}`).join('\n');

  const prompt = (extra = '') => [
    { role: 'system', content:
      `You are a curriculum analyst. Given the section catalog of ONE source ` +
      `document, produce its teaching structure. Return ONLY JSON:\n` +
      `{"primarySubject":"...","concepts":[` +
      `{"title":"<clean concept name>","role":"core|supporting|example|prerequisite",` +
      `"dependsOn":["<concept title>"],"sourceRefs":["S0"],"oneLine":"what a student should learn"}],"omitted":[{"title":"...","reason":"administrative|low teaching value|out of scope"}]}. ` +
      `Rules: concepts must be REAL teaching concepts found in the catalog — ` +
      `not section titles copied verbatim when the title is a slide fragment. ` +
      `Group multiple sections teaching the SAME concept under one concept ` +
      `(list every S-ref). Mark pure motivation demos as role:"example" and ` +
      `attach the concept they illustrate via dependsOn. Mark prerequisite ` +
      `material the lecture merely cites (math foundations etc.) as ` +
      `"prerequisite". Course administration, scheduling, grading, policies, ` +
      `contact info, "what you will learn", and course descriptions MUST go in ` +
      `omitted, never in concepts. At most 9 concepts.${extra}` },
    { role: 'user', content:
      `Document for lecture "${outlineEntry.title}":\n${catalog}` },
  ];

  let out = null, lastErr = null;
  for (let a = 0; a <= MAX_PLAN_RETRIES && !out; a++) {
    try {
      const cand = await chat(prompt(a ? '\nPrevious reply was invalid — return the exact schema.' : ''),
        { json: true, maxTokens: 2500 });
      if (Array.isArray(cand?.concepts) && cand.concepts.length) out = cand;
    } catch (e) { lastErr = e; }
  }
  if (!out) {
    // Deterministic fallback: each teaching section is a concept in doc order.
    out = {
      primarySubject: outlineEntry.title,
      concepts: corpus.teaching.map((s, i) => ({
        title: cleanTitle(s.title), role: i === 0 ? 'core' : 'supporting',
        dependsOn: [], sourceRefs: [`S${i}`], oneLine: s.summary?.slice(0, 120) || s.title,
      })),
      omitted: corpus.excluded.map((s) => ({ title: s.title, reason: s._class.kind })),
      degraded: true,
    };
  }

  // Resolve sourceRefs back to real sections; dedupe repeated concepts;
  // unknown refs are dropped (never invented provenance).
  const seen = new Map();
  const concepts = [];
  for (const c of out.concepts || []) {
    const key = String(c.title || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    if (!key || seen.has(key)) { // merge dupes — combine their sources
      if (seen.has(key)) {
        const prev = seen.get(key);
        for (const r of c.sourceRefs || []) prev._refs.add(r);
        for (const d of c.dependsOn || []) if (!prev.dependsOn.includes(d)) prev.dependsOn.push(d);
      }
      continue;
    }
    const secs = (c.sourceRefs || [])
      .map((r) => corpus.teaching[Number(String(r).replace(/\D/g, ''))])
      .filter(Boolean);
    if (!secs.length) continue; // ungroundable concept → drop
    const rec = {
      title: cleanTitle(c.title), role: ['core', 'supporting', 'example', 'prerequisite'].includes(c.role) ? c.role : 'supporting',
      dependsOn: [...new Set((c.dependsOn || []).map((d) => String(d).trim()))],
      oneLine: String(c.oneLine || '').slice(0, 160),
      sections: secs, _refs: new Set(c.sourceRefs || []),
    };
    seen.set(key, rec);
    concepts.push(rec);
  }
  return {
    primarySubject: String(out.primarySubject || outlineEntry.title).slice(0, 120),
    concepts, omitted: out.omitted || [], degraded: !!out.degraded,
  };
}

// Slide titles like "13 ML in EE: Electrical Load Prediction When and what load?"
// or "▪ Mathematical foundation:..." must not leak into narration as labels.
export function cleanTitle(t) {
  return String(t || '')
    .replace(/^[▪•\-–\d.)\s]+/, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 90) || 'Topic';
}

// ---- Phase 3: teaching plan ---------------------------------------------------
// Dependency-ordered sequence: prerequisites first, core concepts in a
// topological order, each example placed right after the concept it
// illustrates. Deterministic — no second LLM pass needed.
export function buildTeachingPlanV3(outlineEntry, cmap, { minutes = TARGET_MINUTES, wpm = EFFECTIVE_WPM } = {}) {
  const total = Math.round(minutes * wpm);
  const intro = Math.round(total * INTRO_FRacT);
  const recap = Math.round(total * RECAP_FRacT);
  const body = total - intro - recap;
  const minBlock = 45;

  const norm = (t) => String(t).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const byName = new Map(cmap.concepts.map((c) => [norm(c.title), c]));

  // Topological order over dependsOn (prereqs first), tie-broken by role
  // then catalog order. Cycles and unknown deps fall back to input order.
  const roleRank = { prerequisite: 0, core: 1, supporting: 2, example: 3 };
  const input = cmap.concepts;
  const ordered = [];
  const placed = new Set();
  let progress = true;
  const remaining = [...input];
  while (remaining.length && progress) {
    progress = false;
    for (let i = 0; i < remaining.length; i++) {
      const c = remaining[i];
      const deps = c.dependsOn.map(norm).filter((d) => byName.has(d));
      if (deps.every((d) => placed.has(d))) {
        ordered.push(c); placed.add(norm(c.title));
        remaining.splice(i, 1); i--; progress = true;
      }
    }
  }
  ordered.push(...remaining); // unresolved deps → keep input order

  // Examples attach to the concept they illustrate (via dependsOn) — their
  // sources and budget merge into the parent's block, so an example can never
  // be orphaned or budget-starved while its concept is taught.
  const seq = [];
  const exampleOf = new Map();
  for (const c of ordered) {
    if (c.role === 'example') {
      const dep = c.dependsOn.map(norm).find((d) => placed.has(d) && byName.has(d));
      if (dep) {
        if (!exampleOf.has(dep)) exampleOf.set(dep, []);
        exampleOf.get(dep).push(c);
        continue;
      }
      c.role = 'supporting'; // unattached example stays in sequence
    }
    seq.push(c);
  }
  for (const c of seq) {
    c._examples = exampleOf.get(norm(c.title)) || [];
    for (const ex of c._examples) c.sections.push(...ex.sections);
  }

  // Budget: core 3×, supporting 2×, prerequisite 1×; a bound example adds ½×.
  const weight = (c) =>
    ({ core: 3, supporting: 2, example: 1, prerequisite: 1 }[c.role])
    + 0.5 * (c._examples?.length || 0);
  const withExamples = seq;
  const totalW = withExamples.reduce((n, c) => n + weight(c), 0) || 1;
  // Allocate in PRIORITY order (core → supporting → prerequisite) so a tight
  // budget drops optional material, never a core concept; the emitted blocks
  // keep dependency sequence regardless of allocation order.
  const priority = (c) => ({ core: 0, supporting: 1, prerequisite: 2, example: 2 }[c.role]);
  const allocMap = new Map();
  const omitted = [...cmap.omitted];
  let remainingBudget = body;
  for (const c of [...withExamples].sort((a, b) => priority(a) - priority(b))) {
    const alloc = Math.max(minBlock, Math.floor(body * weight(c) / totalW));
    if (remainingBudget >= alloc) {
      allocMap.set(c, alloc); remainingBudget -= alloc;
    } else {
      omitted.push({ title: c.title, role: c.role, reason: 'word budget exhausted' });
    }
  }
  const blocks = withExamples.filter((c) => allocMap.has(c))
    .map((c) => ({ concept: c, budget: allocMap.get(c) }));

  return {
    subject: cmap.primarySubject,
    objective: outlineEntry.title,
    minutes, wpm, wordBudget: total,
    introWords: intro, recapWords: recap,
    blocks: blocks.map((b, i) => ({
      id: `b${i + 1}`,
      title: b.concept.title,
      role: b.concept.role,
      teachingObjective: b.concept.oneLine,
      dependsOn: b.concept.dependsOn,
      examples: (b.concept._examples || []).map((e) => e.title),
      budget: b.budget,
      sources: b.concept.sections.map((s) => ({
        filename: s.filename, documentId: s.document_id, pageStart: s.page_start, pageEnd: s.page_end,
      })),
      transitionIntention: i === 0 ? 'open the subject'
        : b.concept.dependsOn.length ? `build on ${b.concept.dependsOn.join(', ')}`
        : 'extend the developing picture',
    })),
    omitted,
    degraded: cmap.degraded || false,
  };
}

// ---- Phase 4: batched narration ------------------------------------------------
// Each block = one focused call: its evidence, its budget, its predecessors'
// ending, the next block's objective, and the terms already introduced.
// Segments keep source provenance from the block's allowed pages.
// Evidence for one plan block — chunks from its assigned sections/pages in
// document order (never re-fetching the whole PDF).
export function evidenceForBlock(block, corpus) {
  const chunks = block.sources.flatMap((src) =>
    corpus.teaching.filter((s) => s.filename === src.filename).flatMap((s) => s.chunks));
  return chunks.filter((c) =>
    block.sources.some((src) => src.filename === c.filename &&
      (c.page == null || (c.page >= src.pageStart - 1 && c.page <= src.pageEnd + 1))))
    .map((c) => `[src] ${c.filename} p.${c.page ?? '?'}\n${String(c.text).slice(0, 1400)}`)
    .join('\n\n');
}

// Prompt pair for a single narration block — shared by the initial write and
// by post-dedup repair so both produce the same narration shape.
// ctx: {prevEnding, introduced:[...], nextTitle}
export function blockPrompt(plan, outlineEntry, opts, ctx = {}) {
  const files = [...new Set(plan.blocks.flatMap((b) => b.sources.map((s) => s.filename)))];
  const blocksDesc = plan.blocks.map((b) => `${b.id} "${b.title}" (${b.role}, ~${b.budget}w)`).join('; ');
  const sys =
    `You are an expert professor delivering part of a spoken lecture on ` +
    `"${plan.subject}". Write ONLY the segment(s) for this block — natural ` +
    `spoken explanation, precise terminology, teach what/why/how, use the ` +
    `supplied evidence. ` +
    `Never repeat a definition already given, never narrate course logistics ` +
    `(grading, schedule, "this course", policies, contacts), never greet. ` +
    `Transition from the previous section's ending naturally — no robotic ` +
    `"now let's discuss". ` +
    `Return ONLY JSON {"segments":[{"document":"<exact filename>","page":<int>,"text":"<spoken words>"}]}. ` +
    `1–3 segments; TOTAL words ≈ ${opts.budget} (this matters). ` +
    `Each segment's document MUST be one of ${JSON.stringify(files)} and its ` +
    `page MUST appear in the evidence excerpts below.`;
  const usr =
    `Lecture: "${outlineEntry.title}"\nOverall plan: ${blocksDesc}\n\n` +
    `THIS BLOCK: "${opts.title}" — ${opts.objective || ''}\n` +
    `Transition intention: ${opts.transition || 'continue naturally'}\n` +
    (ctx.prevEnding ? `Previous section ended with: "${ctx.prevEnding}"\n` : '') +
    (opts.nextTitle ? `Next section will cover: "${opts.nextTitle}" — stop short of it.\n` : '') +
    (ctx.introduced?.size ? `Already introduced (do not re-define): ${[...ctx.introduced].slice(0, 12).join(', ')}\n` : '') +
    `\nEvidence for THIS block (reference only):\n<<<\n${opts.evidence}\n>>>${opts._fix || ''}`;
  return { sys, usr };
}

// Validate a block response BEFORE accepting its segments — empty, malformed,
// structure-less, or all-fragment replies get a bounded retry with a focused
// correction prompt instead of silently losing the block.
export function validateBlockResponse(raw) {
  if (raw == null) return { ok: false, reason: 'empty response' };
  const list = raw?.segments || (Array.isArray(raw) ? raw : null);
  if (!list) return { ok: false, reason: 'missing "segments" array in response' };
  if (!list.length) return { ok: false, reason: 'segments array is empty' };
  const usable = list.filter((s) => String(s?.text || s?.narration || '').split(/\s+/).filter(Boolean).length >= 15);
  if (!usable.length) return { ok: false, reason: 'no segment has ≥15 words of narration' };
  return { ok: true, list };
}

// Module-level block writer with bounded retry (≤3 attempts). Successful
// responses are never regenerated; only the correction hint changes between
// attempts. accept(list) pushes dedup-checked segments; returns {ok, accepted}.
export async function writeBlockWithRetry(plan, outlineEntry, opts, ctx, accept, deps, meta) {
  const chat = deps.chat || defaultChat;
  let raw = null, reason = 'no attempts made';
  for (let attempt = 0; attempt < 3; attempt++) {
    if (meta) meta.blockAttempts = (meta.blockAttempts || 0) + 1;
    try {
      const { sys, usr } = blockPrompt(plan, outlineEntry, {
        ...opts,
        _fix: attempt ? `\n\nYour previous reply was rejected: ${reason}. Return ONLY the required JSON — segments must each contain ≥15 spoken words, a "document", and a "page" from the evidence.` : '',
      }, ctx);
      raw = await chat([{ role: 'system', content: sys }, { role: 'user', content: usr }],
        { json: true, maxTokens: 2000 });
    } catch (e) {
      reason = `transport error: ${String(e.message || e).slice(0, 120)}`;
      raw = null;
    }
    const check = validateBlockResponse(raw);
    if (check.ok) {
      const accepted = accept(check.list);
      if (accepted) {
        if (attempt) console.log(`[v3] block "${opts.title}" recovered on attempt ${attempt + 1} (${accepted} segments)`);
        return { ok: true, accepted, attempts: attempt + 1 };
      }
      reason = 'all segments were duplicates of earlier narration';
      continue;
    }
    reason = check.reason;
  }
  console.warn(`[v3] block "${opts.title}" failed after 3 attempts: ${reason}`);
  return { ok: false, reason };
}

export async function writeBlocks(outlineEntry, plan, corpus, deps) {
  const segments = [];
  const introduced = new Set();
  let prevEnding = '';
  const takeSegments = (raw, label, block) => {
    const list = raw?.segments || (Array.isArray(raw) ? raw : []);
    const segs = (list || []).map((s) => ({
      id: segments.length,
      section: label,
      document: String(s.document || s.file || '').trim(),
      page: Number(s.page ?? s.pageNumber) || null,
      text: String(s.text || s.narration || '').replace(/\*+/g, '').replace(/\s{2,}/g, ' ').trim(),
      blockId: block?.id || label,
    })).filter((s) => s.text);
    // Duplicates are introduced HERE — a single block response occasionally
    // contains the same paragraph twice. Refuse them at assembly: exact or
    // near-identical text to any already-accepted segment is dropped.
    const kept = [];
    for (const s of segs) {
      if (segments.concat(kept).some((prev) => segmentSimilarity(prev.text, s.text) >= DUP_THRESHOLD)) continue;
      s.id = segments.length + kept.length;
      kept.push(s);
    }
    segments.push(...kept);
    for (const s of kept) introduced.add(label);
    const last = kept.at(-1);
    if (last) prevEnding = last.text.split(/(?<=[.!?])\s+/).slice(-2).join(' ').slice(0, 160);
  };

  const evidenceFor = (block) => evidenceForBlock(block, corpus);

  const blockFailures = [];
  const meta = { blockAttempts: 0, retries: 0 };
  // Intro
  const r0 = await writeBlockWithRetry(plan, outlineEntry, {
    title: `Introduction — what is ${plan.subject}`,
    objective: `Open the lesson by engaging the subject directly: what ${plan.subject} is about and why a student should care.`,
    transition: 'open the subject',
    budget: plan.introWords,
    evidence: plan.blocks[0] ? evidenceFor(plan.blocks[0]) : '',
    nextTitle: plan.blocks[0]?.title,
  }, { prevEnding, introduced }, (list) => {
    const before = segments.length; takeSegments(list, 'Introduction', { id: '__intro' });
    return segments.length - before;
  }, deps, meta);
  if (!r0.ok) blockFailures.push({ blockId: '__intro', title: 'Introduction', reason: r0.reason });

  // Body blocks
  for (let i = 0; i < plan.blocks.length; i++) {
    const b = plan.blocks[i];
    const r = await writeBlockWithRetry(plan, outlineEntry, {
      title: b.title,
      objective: b.teachingObjective +
        (b.examples?.length ? ` Illustrate it concretely with: ${b.examples.join('; ')}.` : ''),
      transition: b.transitionIntention,
      budget: b.budget, evidence: evidenceFor(b), nextTitle: plan.blocks[i + 1]?.title,
    }, { prevEnding, introduced }, (list) => {
      const before = segments.length; takeSegments(list, b.title, b);
      return segments.length - before;
    }, deps, meta);
    if (!r.ok) blockFailures.push({ blockId: b.id, title: b.title, role: b.role, reason: r.reason });
  }

  // Conclusion
  const rN = await writeBlockWithRetry(plan, outlineEntry, {
    title: 'Recap', objective: `Close the lesson: in a few sentences, restate the mental model a student should carry away about ${plan.subject}.`,
    transition: 'conclude the lesson',
    budget: plan.recapWords,
    evidence: plan.blocks.at(-1) ? evidenceFor(plan.blocks.at(-1)) : '',
  }, { prevEnding, introduced }, (list) => {
    const before = segments.length; takeSegments(list, 'Recap', { id: '__recap' });
    return segments.length - before;
  }, deps, meta);
  if (!rN.ok) blockFailures.push({ blockId: '__recap', title: 'Recap', reason: rN.reason });

  const parsed = { title: cleanTitle(plan.objective), segments, sections: segsToSections(segments) };
  parsed.blockFailures = blockFailures;
  parsed.writeMeta = meta;
  return parsed;
}

// ---- deterministic checks ------------------------------------------------------
// Text normalization for duplicate detection — whitespace, punctuation, and
// case are ignored so byte-level differences can't hide identical passages.
export function normalizeText(t) {
  return String(t || '').toLowerCase().replace(/[^\p{L}\p{N} ]/gu, ' ')
    .replace(/\s+/g, ' ').trim();
}

// Word 4-gram CONTAINMENT — how much of segment A's phrasing literally
// appears in segment B. Identical paragraphs score 1.0; cosmetic variants
// stay ≥0.8; two segments about the same topic but with different
// sentences share only vocabulary, not word sequences, and stay low.
export function segmentSimilarity(a, b) {
  const grams = (t) => {
    const w = normalizeText(t).split(' ').filter(Boolean);
    if (w.length < 4) return new Set([w.join(' ')]);
    const s = new Set();
    for (let i = 0; i + 4 <= w.length; i++) s.add(w.slice(i, i + 4).join(' '));
    return s;
  };
  const ga = grams(a), gb = grams(b);
  if (!ga.size || !gb.size) return 0;
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter++;
  return inter / Math.min(ga.size, gb.size); // containment in the shorter side
}
export const DUP_THRESHOLD = 0.7;

// Two kinds of findings:
//   'duplicate'  — whole-segment similarity ≥ DUP_THRESHOLD (hard failure).
//   'repetition' — shared 5-gram across distinct segments (soft, threshold 3).
export function detectRepetition(segments) {
  const findings = [];
  const seenDupPairs = new Set();
  for (let i = 0; i < segments.length; i++) {
    for (let j = i + 1; j < segments.length; j++) {
      const sim = segmentSimilarity(segments[i].text, segments[j].text);
      if (sim >= DUP_THRESHOLD && !seenDupPairs.has(`${i},${j}`)) {
        seenDupPairs.add(`${i},${j}`);
        findings.push({ type: 'duplicate', segment: segments[j].id, also: segments[i].id,
          similarity: +sim.toFixed(2), evidence: normalizeText(segments[j].text).slice(0, 60) });
      }
    }
  }
  const grams = new Map(); // gram → first segment id
  for (const s of segments) {
    const words = normalizeText(s.text).split(' ').filter(Boolean);
    for (let i = 0; i + 5 <= words.length; i++) {
      const g = words.slice(i, i + 5).join(' ');
      if (grams.has(g) && grams.get(g) !== s.id) {
        if (!seenDupPairs.size || !findings.some((f) => f.segment === s.id)) {
          findings.push({ type: 'repetition', segment: s.id, also: grams.get(g), evidence: g });
        }
        break;
      }
      grams.set(g, s.id);
    }
  }
  return findings;
}

// Deterministic whole-segment dedup — removes only exact/near-identical
// LATER copies (≥DUP_THRESHOLD). Recaps use different wording and survive.
// NOT a substitute for the cause: assembly refuses dups in takeSegments;
// this is the final safety net, and removals are reported, not silent.
export function dedupeSegments(segments) {
  const kept = [];
  const removed = [];
  for (const s of segments) {
    if (kept.some((p) => segmentSimilarity(p.text, s.text) >= DUP_THRESHOLD)) { removed.push(s.id); continue; }
    kept.push(s);
  }
  kept.forEach((s, i) => { s.id = i; });
  return { segments: kept, removedIds: removed };
}

// ---- post-dedup coverage ---------------------------------------------------
// After dedup, some plan blocks may have lost ALL their narration (the only
// paragraph they had was a duplicate). Detect which planned content is now
// missing or under-explained.
export function blockGaps(parsed, plan) {
  const byBlock = new Map();
  for (const s of parsed.segments) {
    byBlock.set(s.blockId, (byBlock.get(s.blockId) || 0) + s.text.split(/\s+/).filter(Boolean).length);
  }
  const gaps = [];
  if (!parsed.segments.some((s) => s.blockId === '__intro')) {
    gaps.push({ blockId: '__intro', title: `Introduction — what is ${plan.subject}`,
      objective: `Open the lesson by engaging the subject directly: what ${plan.subject} is about.`,
      transition: 'open the subject', budget: plan.introWords, reason: 'missing introduction',
      sources: plan.blocks[0]?.sources || [] });
  }
  for (const b of plan.blocks || []) {
    const w = byBlock.get(b.id) || 0;
    const need = b.role === 'core' ? 30 : Math.min(30, Math.round(b.budget * 0.35));
    if (w < need) {
      gaps.push({ ...b, blockId: b.id, budget: b.budget, objective: b.teachingObjective +
        (b.examples?.length ? ` Illustrate it concretely with: ${b.examples.join('; ')}.` : ''),
        reason: w ? `under-explained (${w}w < ${need}w)` : 'content lost to dedup/failure',
        sources: b.sources });
    }
  }
  if (!parsed.segments.some((s) => s.blockId === '__recap')) {
    gaps.push({ blockId: '__recap', title: 'Recap',
      objective: `Close the lesson: restate the mental model about ${plan.subject} in a few sentences.`,
      transition: 'conclude the lesson', budget: plan.recapWords, reason: 'missing conclusion',
      sources: plan.blocks.at(-1)?.sources || [] });
  }
  return gaps;
}

// Targeted repair — regenerate ONLY the missing/under-explained blocks, using
// their original evidence + teaching-plan context. One bounded pass; repaired
// segments are appended then reordered; dedup runs again afterwards.
export async function repairGaps(parsed, plan, corpus, gaps, deps, meta) {
  if (!gaps.length) return { repaired: 0, stillMissing: [] };
  const corpusLike = { teaching: corpus.teaching };
  const byBlockOrder = (s) => s.blockId === '__intro' ? -1
    : s.blockId === '__recap' ? plan.blocks.length
    : plan.blocks.findIndex((b) => b.id === s.blockId);
  const stillMissing = [];
  let repaired = 0;
  const newSegs = [];
  for (const gap of gaps) {
    const block = gap.blockId === '__intro' ? { id: '__intro' }
      : gap.blockId === '__recap' ? { id: '__recap' }
      : plan.blocks.find((b) => b.id === gap.blockId) || { id: gap.blockId };
    const evidence = gap.sources?.length
      ? evidenceForBlock({ ...gap, sources: gap.sources }, corpusLike)
      : '';
    const label = gap.title;
    const r = await writeBlockWithRetry(plan, { title: plan.objective }, {
      title: label, objective: gap.objective, transition: gap.transition || 'continue naturally',
      budget: gap.budget, evidence,
    }, { introduced: new Set(parsed.segments.map((s) => s.section)) }, (list) => {
      const segs = (list || []).map((s) => ({
        id: -1, section: label,
        document: String(s.document || s.file || '').trim(),
        page: Number(s.page ?? s.pageNumber) || null,
        text: String(s.text || s.narration || '').replace(/\*+/g, '').replace(/\s{2,}/g, ' ').trim(),
        blockId: gap.blockId,
      })).filter((s) => s.text
        && !parsed.segments.concat(newSegs).some((p) => segmentSimilarity(p.text, s.text) >= DUP_THRESHOLD));
      newSegs.push(...segs);
      return segs.length;
    }, deps, meta);
    if (r.ok) repaired++; else stillMissing.push({ blockId: gap.blockId, title: label, reason: r.reason });
  }
  // Merge + reorder into plan sequence (intro → plan order → recap).
  parsed.segments = parsed.segments.concat(newSegs)
    .sort((a, b) => byBlockOrder(a) - byBlockOrder(b) || (a.page || 0) - (b.page || 0) || a.id - b.id);
  parsed.segments.forEach((s, i) => { s.id = i; });
  parsed.sections = segsToSections(parsed.segments);
  return { repaired, stillMissing };
}

export function detectAdminLeak(segments) {
  const leaks = [];
  for (const s of segments) {
    if (ADMIN_NARRATION.test(s.text) || COURSE_DESC_RE.test(s.text)) {
      leaks.push({ type: 'admin', segment: s.id, evidence: s.text.slice(0, 80) });
    }
  }
  return leaks;
}

// ---- Phase 5: length control — compress, never delete --------------------------
export async function compressOvershootV3(parsed, plan, deps) {
  const chat = deps.chat || defaultChat;
  // Find over-budget blocks (40% above budget) — compress ONLY those.
  const byBlock = new Map();
  for (const s of parsed.segments) byBlock.set(s.blockId, (byBlock.get(s.blockId) || 0) + s.text.split(/\s+/).filter(Boolean).length);
  const overBudget = new Set(plan.blocks.filter((b) => (byBlock.get(b.id) || 0) > b.budget * 1.4).map((b) => b.id));
  const targets = overBudget.size ? overBudget : new Set(plan.blocks.map((b) => b.id));
  const segs = parsed.segments.filter((s) => targets.has(s.blockId));
  if (!segs.length) return parsed;
  try {
    const out = await chat([
      { role: 'system', content:
        `Tighten these lecture segments to ~70% length. Keep every concept and ` +
        `definition, remove redundant phrasing. Keep document/page/section ` +
        `UNCHANGED. Return JSON {"segments":[{"id":<int>,"text":"..."}]}.` },
      { role: 'user', content: segs.map((s) =>
        `{"id":${s.id},"text":${JSON.stringify(s.text)}}`).join('\n') },
    ], { json: true, maxTokens: 4000 });
    const edits = new Map((out?.segments || []).map((x) => [x.id, x.text]));
    for (const s of parsed.segments) {
      const t = edits.get(s.id);
      if (t && String(t).trim()) s.text = String(t).replace(/\s{2,}/g, ' ').trim();
    }
  } catch { /* validation reports overflow */ }
  parsed.sections = segsToSections(parsed.segments);
  return parsed;
}

// ---- Phase 6: structured critic + bounded targeted revision ---------------------
export async function critiqueV3(parsed, plan, deps) {
  const deterministic = [
    ...detectRepetition(parsed.segments).map((f) => ({
      segment: f.segment, severity: 'high', problem: `repeats wording from segment ${f.also}`,
      evidence: f.evidence, action: 'rewrite to avoid re-defining or re-stating',
    })),
    ...detectAdminLeak(parsed.segments).map((f) => ({
      segment: f.segment, severity: 'high', problem: 'administrative/course-description content',
      evidence: f.evidence, action: 'remove course logistics; keep subject matter',
    })),
  ];
  const chat = deps.chat || defaultChat;
  let llmFindings = [];
  try {
    const script = parsed.segments.map((s) =>
      `#${s.id} [${s.section}] p${s.page}: ${s.text}`).join('\n');
    const planned = plan.blocks.map((b) => `${b.id} "${b.title}" (${b.role}, ~${b.budget}w)`).join('; ');
    const out = await chat([
      { role: 'system', content:
        `You are a strict pedagogical critic. Judge the script on: (a) technical ` +
        `accuracy, (b) does it TEACH (intuition + explanation, not just names), ` +
        `(c) coherence & transitions, (d) repetition, (e) essential-topic depth, ` +
        `(f) relevance (no admin/course talk), (g) grounding (claims supported ` +
        `by source scope). Return ONLY JSON {"findings":[{"segment":<int|null>,` +
        `"problem":"...","severity":"high|medium|low","evidence":"...","action":"..."}]}. ` +
        `Specific and surgical; [] if clean.` },
      { role: 'user', content:
        `Lecture: "${plan.objective}"\nPlan: ${planned}\n\nScript:\n${script}` },
    ], { json: true, maxTokens: 1600 });
    llmFindings = (out?.findings || []).filter((f) => f && (f.problem || f.action)).slice(0, 10);
  } catch { /* LLM critic unavailable — deterministic findings still apply */ }
  const merged = [...deterministic];
  for (const f of llmFindings) {
    if (merged.some((m) => m.segment === f.segment && m.problem === f.problem)) continue;
    merged.push({ segment: f.segment ?? null, severity: f.severity || 'medium', problem: f.problem, evidence: f.evidence || '', action: f.action || 'fix' });
  }
  return { findings: merged, llmFindings: llmFindings.length, deterministicFindings: deterministic.length };
}

export async function reviseV3(parsed, findings, plan, deps) {
  const chat = deps.chat || defaultChat;
  const targetIds = new Set(findings.map((f) => f.segment).filter((x) => x != null));
  const segs = targetIds.size
    ? parsed.segments.filter((s) => targetIds.has(s.id))
    : parsed.segments;
  try {
    const out = await chat([
      { role: 'system', content:
        `Revise ONLY these segments to fix the findings; preserve meaning, ` +
        `document/page fields, and neighboring flow. Return JSON ` +
        `{"segments":[{"id":<int>,"section":"...","document":"...","page":<int>,"text":"..."}]}.` },
      { role: 'user', content:
        `Findings:\n${findings.map((f, i) => `${i + 1}. seg ${f.segment ?? '—'}: ${f.problem} → ${f.action}`).join('\n')}\n\n` +
        `Segments to revise:\n${segs.map((s) => JSON.stringify(s)).join('\n')}` },
    ], { json: true, maxTokens: 4000 });
    const edits = new Map((out?.segments || []).map((x) => [x.id, x]));
    for (const s of parsed.segments) {
      const e = edits.get(s.id);
      if (e && e.text) {
        s.text = String(e.text).replace(/\s{2,}/g, ' ').trim();
        if (e.page != null) s.page = Number(e.page);
      }
    }
  } catch { /* keep original */ }
  parsed.sections = segsToSections(parsed.segments);
  return parsed;
}

// ---- validation -------------------------------------------------------------------
export function validateLectureV3(parsed, allowedDocs, plan) {
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
  if (words < WORD_BAND[0]) problems.push(`too short (${words} < ${WORD_BAND[0]})`);
  if (words > WORD_BAND[1]) problems.push(`too long (${words} > ${WORD_BAND[1]})`);
  // IDs must be unique and sequential for the canonical manifest.
  const ids = parsed.segments.map((s) => s.id);
  if (new Set(ids).size !== ids.length) problems.push('duplicate segment ids');
  for (const [i, s] of parsed.segments.slice(0, 2).entries()) {
    if (ADMIN_NARRATION.test(s.text) || COURSE_DESC_RE.test(s.text)) {
      problems.push(`segment ${i + 1} opens on administrative content`);
    }
  }
  // A script must not start mid-explanation — an intro block is required.
  const first = parsed.segments[0];
  if (first && !(first.blockId === '__intro' || /intro|opening|begin/i.test(first.section || ''))) {
    problems.push('script lacks an introduction — it opens mid-explanation');
  }
  // A conclusion is required — the lesson must end with a recap.
  const last = parsed.segments.at(-1);
  if (last && !(last.blockId === '__recap' || /recap|summary|conclusion|closing/i.test(last.section || ''))) {
    problems.push('script lacks a conclusion — it ends without a recap');
  }
  // Essential/core blocks must be meaningfully narrated.
  if (plan?.blocks?.length) {
    const byBlock = new Map();
    for (const s of parsed.segments) {
      byBlock.set(s.blockId, (byBlock.get(s.blockId) || 0) + s.text.split(/\s+/).filter(Boolean).length);
    }
    for (const b of plan.blocks) {
      if (b.role === 'core' && (byBlock.get(b.id) || 0) < 30) {
        problems.push(`core concept "${b.title}" has <30 words — named, not explained`);
      }
    }
  }
  const reps = detectRepetition(parsed.segments);
  const dups = reps.filter((f) => f.type === 'duplicate');
  if (dups.length) problems.push(`${dups.length} duplicate paragraph(s) detected (e.g. segment ${dups[0].segment} repeats ${dups[0].also})`);
  else if (reps.length >= 3) problems.push(`repetition across ${reps.length} segments`);
  // Blocks whose writing failed after all retries and repairs must not ship.
  for (const bf of parsed.blockFailures || []) {
    problems.push(`block "${bf.title}" produced no usable narration: ${bf.reason}`);
  }
  return { ok: !problems.length, problems, words };
}

// ---- orchestration ------------------------------------------------------------------
export async function generateLectureV3(courseId, outlineEntry, deps = {}) {
  const meta = { version: GENERATOR_VERSION, promptVersion: PROMPT_VERSION,
    model: process.env.COURSE_LLM_MODEL || 'qwen3:8b', targetMinutes: TARGET_MINUTES,
    effectiveWpm: EFFECTIVE_WPM, wordBudget: WORD_BUDGET, llmCalls: 0,
    startedAt: Date.now(), promptChars: 0 };
  const countedChat = async (msgs, opts) => {
    meta.llmCalls += 1;
    meta.promptChars += msgs.reduce((n, m) => n + String(m.content).length, 0);
    return (deps.chat || defaultChat)(msgs, opts);
  };
  const myDeps = { ...deps, chat: countedChat };

  const allowedDocs = Object.fromEntries((outlineEntry.sources || [])
    .map((s) => [s.filename, { documentId: s.documentId, pages: s.pages }]));

  const corpus = await loadCorpus(courseId, outlineEntry, myDeps);
  const cmap = await buildConceptMap(outlineEntry, corpus, myDeps);
  const plan = buildTeachingPlanV3(outlineEntry, cmap, {});
  if (!plan.blocks.length) {
    throw new Error(`No teachable concepts for "${outlineEntry.title}" — source appears administrative-only`);
  }

  let parsed = await writeBlocks(outlineEntry, plan, corpus, myDeps);
  if (!parsed.segments.length) throw new Error('LLM produced no usable script');
  meta.blockAttempts = parsed.writeMeta?.blockAttempts || 0;

  // Assembly dedup — takeSegments refuses identical text, but a near-dup
  // (cosmetic edits) can still slip through; remove it before the gates.
  {
    const { segments: dd, removedIds } = dedupeSegments(parsed.segments);
    if (removedIds.length) {
      console.log(`[v3] lecture ${outlineEntry.idx}: removed ${removedIds.length} duplicate segment(s)`);
      parsed.segments = dd;
      parsed.sections = segsToSections(dd);
    }
  }

  // Post-dedup coverage — dedup may have gutted a planned block. Detect
  // missing intro/conclusion and under-explained concepts, then repair ONLY
  // those blocks with their original evidence. Bounded to one pass.
  const gaps = blockGaps(parsed, plan);
  if (gaps.length) {
    console.log(`[v3] lecture ${outlineEntry.idx}: repairing ${gaps.length} missing/under-explained block(s)`);
    const { repaired, stillMissing } = await repairGaps(parsed, plan, corpus, gaps, myDeps, meta);
    meta.repairedBlocks = repaired;
    // Repaired-or-failed status replaces the write-phase failures — a block
    // only stays a failure if the repair also failed.
    parsed.blockFailures = stillMissing;
    // Repair may introduce new duplicates — dedup again.
    const { segments: dd2, removedIds: rm2 } = dedupeSegments(parsed.segments);
    if (rm2.length) { parsed.segments = dd2; parsed.sections = segsToSections(dd2); }
  }

  // Length control — compress over-budget blocks; never delete trailing.
  let v = validateLectureV3(parsed, allowedDocs, plan);
  if (!v.ok && v.problems.some((p) => p.startsWith('too long'))) {
    parsed = await compressOvershootV3(parsed, plan, myDeps);
    v = validateLectureV3(parsed, allowedDocs, plan);
  }

  // Bounded critic → targeted revision.
  let revisions = 0;
  const allFindings = [];
  for (; revisions < MAX_REVISION_CYCLES; revisions++) {
    const { findings } = await critiqueV3(parsed, plan, myDeps).catch(() => ({ findings: [] }));
    allFindings.push(...findings);
    if (!findings.length) break;
    parsed = await reviseV3(parsed, findings, plan, myDeps);
    const rv = validateLectureV3(parsed, allowedDocs, plan);
    if (rv.ok) break;
    if (rv.problems.some((p) => p.startsWith('too long'))) {
      parsed = await compressOvershootV3(parsed, plan, myDeps);
    }
  }
  meta.revisionCycles = revisions;

  // Final integrity pass — revisions/compression can reintroduce dups.
  {
    const { segments: dd, removedIds } = dedupeSegments(parsed.segments);
    if (removedIds.length) {
      parsed.segments = dd;
      parsed.sections = segsToSections(dd);
    }
  }
  const final = validateLectureV3(parsed, allowedDocs, plan);
  parsed.validation = final.ok ? undefined : { ok: false, problems: final.problems };
  if (parsed.title === 'Untitled lecture') parsed.title = outlineEntry.title;
  parsed.wordCount = wordCount(parsed);
  parsed.estimatedMinutes = parsed.wordCount / EFFECTIVE_WPM;
  parsed.plan = { subject: plan.subject, objective: plan.objective, blocks: plan.blocks, omitted: plan.omitted, degraded: plan.degraded };
  parsed.inventorySummary = {
    concepts: cmap.concepts.map((c) => ({ title: c.title, role: c.role })),
    excluded: corpus.excluded.map((s) => ({ title: s.title, kind: s._class.kind })),
    unprocessedPages: corpus.unprocessedPages,
  };
  parsed.criticFindings = allFindings;
  meta.wordCount = parsed.wordCount;
  meta.estimatedMinutes = parsed.estimatedMinutes;
  meta.elapsedMs = Date.now() - meta.startedAt;
  parsed.genMeta = meta;
  return parsed;
}

// ---- eval record ----------------------------------------------------------------
export async function recordEvalV3(courseId, outlineEntry, lecture, { genMeta = null, generatorVersion = GENERATOR_VERSION } = {}) {
  // Source-doc fingerprint for reproducibility.
  let docSha = null;
  try {
    const { rows: docs } = await getPool().query(
      `SELECT room_id, filename FROM course_documents WHERE course_id=$1 AND status='ready'`, [courseId]);
    const h = crypto.createHash('sha256');
    for (const d of docs) {
      const f = path.join(MATERIALS_DIR, d.room_id, d.filename);
      if (existsSync(f)) h.update(await fsp.readFile(f));
    }
    docSha = h.digest('hex');
  } catch { docSha = null; }

  const rec = {
    at: new Date().toISOString(),
    generatorVersion,
    promptVersion: genMeta?.promptVersion || PROMPT_VERSION,
    model: genMeta?.model || 'qwen3:8b',
    docSha256: docSha,
    courseId, lecture: outlineEntry.title,
    wordCount: lecture.wordCount,
    estimatedMinutes: lecture.estimatedMinutes,
    llmCalls: genMeta?.llmCalls ?? null,
    llmUsage: genMeta?.llmUsage || null,
    promptChars: genMeta?.promptChars ?? null,
    approxPromptTokens: genMeta?.promptChars ? Math.round(genMeta.promptChars / 3.5) : null,
    revisionCycles: genMeta?.revisionCycles ?? null,
    elapsedMs: genMeta?.elapsedMs ?? null,
    validation: lecture.validation || { ok: true },
    criticFindings: lecture.criticFindings || [],
    plan: lecture.plan || null,
    provenance: {
      total: lecture.segments.length,
      withDoc: lecture.segments.filter((s) => s.document).length,
      withPage: lecture.segments.filter((s) => s.page != null).length,
    },
    adminLeakSegments: lecture.segments.filter((s) => ADMIN_NARRATION.test(s.text) || COURSE_DESC_RE.test(s.text)).length,
    repetitionFindings: detectRepetition(lecture.segments).length,
  };
  try {
    await fsp.mkdir(EVAL_DIR, { recursive: true });
    const lid = `gen_${courseId.slice(0, 8)}_L${outlineEntry.idx}`;
    await fsp.writeFile(path.join(EVAL_DIR, `${lid}_${generatorVersion}.json`), JSON.stringify(rec, null, 2));
    const csvPath = path.join(EVAL_DIR, 'records.csv');
    if (!existsSync(csvPath)) {
      await fsp.writeFile(csvPath, 'at,version,model,course,idx,title,words,estMin,llmCalls,revisions,elapsedMs,validation,segsWithDoc,segsWithPage,adminLeak\n');
    }
    await fsp.appendFile(csvPath, [
      rec.at, rec.generatorVersion, rec.model, courseId.slice(0, 8), outlineEntry.idx,
      JSON.stringify(outlineEntry.title).replace(/,/g, ';'), rec.wordCount,
      rec.estimatedMinutes?.toFixed?.(1), rec.llmCalls, rec.revisionCycles,
      rec.elapsedMs, rec.validation.ok ? 'ok' : 'FAIL',
      rec.provenance.withDoc, rec.provenance.withPage, rec.adminLeakSegments].join(',') + '\n');
  } catch (e) {
    console.warn('[eval] record write failed:', e.message);
  }
  return rec;
}
