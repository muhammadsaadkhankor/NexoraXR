// FAST generator (v4 "fast") — replaces V3's per-block narration loop with a
// two-call-per-lecture pipeline:
//   A) deterministic corpus (V3's loadCorpus — no LLM, reuses parsed sections)
//   B) ONE compact planning call → objective + 4–6 ordered concepts
//   C) ONE coherent narration call → full script (intro → concepts → recap)
//   D) deterministic validation (shared V3 gates) + bounded repair ONLY on
//      concrete failures (no unconditional critic pass).
// Output contract (segments/title/sections/plan/validation/genMeta) is the
// same shape V3 emits, so emitLecture, drafts, and eval records are unchanged.
//
// Env:
//   COURSE_FAST_MINUTES    — target narration length (default TARGET_MINUTES)
//   COURSE_FAST_MAXTOK     — narration output cap (default 6000)
//   COURSE_FAST_GROUPCALLS — 'concepts' splits narration into per-concept calls
//                            (only for very large corpora; recorded in meta)

import { chat as defaultChat, takeLlmUsage } from './llm.mjs';
import { segsToSections } from './generator.mjs';
import {
  loadCorpus, cleanTitle, EFFECTIVE_WPM, TARGET_MINUTES,
  evidenceForBlock, validateBlockResponse, normalizeText,
  detectRepetition, dedupeSegments, blockGaps, repairGaps,
  validateLectureV3, compressOvershootV3,
} from './generator3.mjs';

export const GENERATOR_VERSION = 'fast.1';
export const PROMPT_VERSION = 'fast-2call-2026-10-26';

// Planning word budget — PLAN_WPM is the words the script should contain
// (~130 → a 10-minute target ≈ 1,300 words of rich narration). EFFECTIVE_WPM
// stays 72 for AUDIO-duration estimates (measured VoxCPM rate) — the two are
// deliberately different: script length drives teaching depth, not playback
// clock time, which the user reviews before baking audio.
const FAST_MINUTES = Math.min(15, Math.max(5, Number(process.env.COURSE_FAST_MINUTES || TARGET_MINUTES)));
const PLAN_WPM = Math.min(160, Math.max(80, Number(process.env.COURSE_PLAN_WPM || 130)));
// Pre-TTS draft gate (drafts.mjs: validateDraftScript) rejects scripts over
// 1500 words — never budget beyond this ceiling or generated drafts can't
// be approved/baked. 1450 leaves margin for reviewer edits.
const SCRIPT_WORD_CEILING = Number(process.env.COURSE_SCRIPT_WORD_CEILING || 1450);
const targetWordsFor = (minutes) =>
  Math.min(SCRIPT_WORD_CEILING, Math.round(minutes * PLAN_WPM));
const MAX_TOKENS = Number(process.env.COURSE_FAST_MAXTOK || 6000);
const MAX_EVIDENCE_CHARS = Number(process.env.COURSE_FAST_EVIDENCE || 24000);
// Minimum narration a concept deserves — high importance needs a worked
// explanation, medium a solid paragraph. Drives the recommendedMinutes
// estimate when the requested duration can't fit the full topic inventory.
const MIN_WORDS_PER_CONCEPT = { high: 130, medium: 80 };

const num = (v, def = null) => (Number.isFinite(Number(v)) ? Number(v) : def);

// ---- Stage B — compact teaching plan (ONE call) ------------------------------
export function planPrompt(outlineEntry, corpus) {
  const outline = corpus.teaching.slice(0, 80).map((s) =>
    `- "${s.title}" (${s.filename} p.${s.pageStart}–${s.pageEnd}${s.summary ? `: ${String(s.summary).slice(0, 90)}` : ''})`
  ).join('\n');
  return {
    sys:
      `You are a senior lecturer planning ONE lecture titled "${outlineEntry.title}". ` +
      `From the document outline, select the concepts a student must ` +
      `understand — cover EVERY instructional topic in the outline (typically 4–8 concepts, ` +
      `more when the material genuinely has more; administrative slides like syllabus, ` +
      `grading, schedule, and logistics are the only legitimate omissions). ` +
      `Merge related slides into ONE concept — do not make one concept per slide — but never ` +
      `skip a substantive later slide just because earlier ones exist. ` +
      `Order them by LEARNING DEPENDENCY — each concept should be understandable ` +
      `only from concepts before it (prerequisites first, then applications). ` +
      `Return ONLY JSON {"objective":"<one-line teaching objective>","concepts":` +
      `[{"title":"<concept>","importance":"high|medium","why":"<1-line reason it matters>",` +
      `"examples":["<concrete example from source>"],"source":"<exact filename>",` +
      `"pageStart":<int>,"pageEnd":<int>}],"omitted":["<topic genuinely absent or non-essential>"]}. ` +
      `At most 2 concepts may be "medium" importance — the rest are the lecture's core. ` +
      `Sources must exactly match document names listed; pages come from the outline ranges. ` +
      `Give each concept the TIGHTEST page range that covers it — page ranges are used to ` +
      `sync narration to slides, so a concept must not claim pages belonging to another topic.`,
    usr:
      `Lecture: "${outlineEntry.title}"\n\nDocument outline (title — file pages — summary):\n${outline}\n\n` +
      `Pick the essential 4–6 concepts in teachable dependency order.`,
  };
}

// Deterministic fallback plan — preserve source order (proven correct), flag
// degraded output explicitly in meta.
export function fallbackPlan(outlineEntry, corpus) {
  const secs = corpus.teaching.slice(0, 12);
  return {
    objective: outlineEntry.title,
    concepts: secs.map((s, i) => ({
      title: s.title, order: i + 1, why: `Source section "${s.title}"`,
      examples: [], source: s.filename, pageStart: s.pageStart, pageEnd: s.pageEnd,
    })),
    omitted: corpus.teaching.slice(6).map((s) => s.title),
    _fallback: true,
  };
}

export function validatePlan(raw, corpus) {
  const files = new Set(corpus.teaching.map((s) => s.filename));
  const concepts = (raw?.concepts || []).filter((c) =>
    c && typeof c.title === 'string' && c.title.trim()
      && (files.has(c.source) || corpus.teaching.some((s) => normalizeText(s.title) === normalizeText(c.title))));
  if (!raw || typeof raw.objective !== 'string' || !concepts.length) {
    return { ok: false, reason: 'missing objective or no valid concepts' };
  }
  return { ok: true, plan: {
    objective: raw.objective.trim(),
    concepts: concepts.slice(0, 12).map((c, i) => ({
      title: c.title.trim(), order: i + 1, why: String(c.why || '').slice(0, 200),
      importance: /medium|low|minor|supporting/i.test(String(c.importance || '')) ? 'medium' : 'high',
      examples: Array.isArray(c.examples) ? c.examples.slice(0, 3).map(String) : [],
      source: files.has(c.source) ? c.source : (corpus.teaching.find((s) => normalizeText(s.title) === normalizeText(c.title))?.filename || corpus.teaching[0]?.filename),
      pageStart: num(c.pageStart, corpus.teaching[0]?.pageStart || 1),
      pageEnd: num(c.pageEnd, corpus.teaching[0]?.pageEnd || 1),
    })),
    omitted: Array.isArray(raw.omitted) ? raw.omitted.map(String) : [],
  } };
}

// ---- Stage C — one-call narration -------------------------------------------
// Evidence per concept: spread across its page range (first + later chunks)
// instead of a contiguous head slice, so worked examples/deeper material is
// visible to the writer.
export function conceptEvidence(concept, corpus, cap = 3200) {
  const chunks = corpus.teaching.filter((s) => s.filename === concept.source)
    .flatMap((s) => s.chunks || [])
    .filter((c) => c.page == null ||
      (c.page >= concept.pageStart - 1 && c.page <= concept.pageEnd + 1));
  if (!chunks.length) {
    return evidenceForBlock({ sources: [{ filename: concept.source, pageStart: concept.pageStart - 1, pageEnd: concept.pageEnd + 1 }] }, corpus).slice(0, cap);
  }
  // Spread up to 5 chunks evenly across the range — math slides need the
  // derivation pages, not just the opener/closer.
  const pick = chunks.length <= 5 ? chunks
    : Array.from({ length: 5 }, (_, i) => chunks[Math.round(i * (chunks.length - 1) / 4)])
        .filter((v, i, a) => a.indexOf(v) === i);
  return pick.map((c) => `[src] ${c.filename} p.${c.page ?? '?'}\n${String(c.text).slice(0, Math.floor(cap / pick.length))}`).join('\n\n');
}

export function narrationPrompt(outlineEntry, plan, corpus, fix = '', opts = {}) {
  const targetWords = opts.targetWords || targetWordsFor(FAST_MINUTES);
  const minutes = opts.minutes || FAST_MINUTES;
  const evidence = [];
  let left = MAX_EVIDENCE_CHARS;
  for (const c of plan.concepts) {
    const chunkText = conceptEvidence(c, corpus);
    if (!chunkText || left <= 0) continue;
    const take = chunkText.slice(0, left);
    evidence.push(`### ${c.title} (${c.source} p.${c.pageStart}–${c.pageEnd})\n${take}`);
    left -= take.length;
  }
  const weightOf = (c) => (c.importance === 'medium' ? 1 : 2);
  const totalW = plan.concepts.reduce((n, c) => n + weightOf(c), 0);
  const bodyWords = Math.max(0, targetWords - 100);
  const budgetOf = (c) => Math.max(c.importance === 'medium' ? 60 : 100,
    Math.round(bodyWords * weightOf(c) / totalW));
  return {
    sys:
      `You are an expert professor delivering a spoken lecture on "${plan.objective}". ` +
      `Write the WHOLE script in ONE response — one connected spoken explanation, ` +
      `not a list of slide summaries. ` +
      `Style rules that matter: ` +
      `– Explain the idea BEFORE naming the jargon. A student must understand the mechanism, not just hear the term. ` +
      `– Every concept gets a real explanation (what it is, how it works, why it matters) — never a one-sentence definition followed by nothing. ` +
      `– When an example is given, use it to show HOW the concept works — walk through it — don't just name it. ` +
      `– Mathematics and algorithms: when the evidence contains an equation or formula, ` +
      `explain it fully — name every symbol and variable in words, describe what the ` +
      `equation computes and why, and walk through the small numeric example when the ` +
      `source provides one. Verbalize notation for speech (write "w zero", "J of w", ` +
      `"x superscript i", "sum over n", "the derivative of J with respect to w") — ` +
      `never output raw symbols like f(x), w₀, J(w₁), ∂, or ∑ alone. ` +
      `– Connect concepts: each new idea should clearly follow from the previous one (brief natural transitions, no robotic "now let's discuss"). ` +
      `– No repeated definitions, no restating the same idea in different words. ` +
      `– NO filler: never write "an example illustrates…", "this concept is important…", "these components work together…" without actual explanation. ` +
      `– No course logistics (grading, schedule, contacts), no greetings. ` +
      `– Each segment must be a complete paragraph of 40–150 spoken words — never a single-sentence fragment. ` +
      `– Open by explaining "${plan.objective}" in plain terms (no "welcome"); close with a conceptual recap that ties the ideas together. ` +
      `Return ONLY JSON {"segments":[{"document":"<exact filename>","page":<int>,` +
      `"concept":"<the concept this segment teaches>","text":"<spoken words>"}]}. ` +
      `TOTAL across all segments ≈ ${targetWords} words (target ≈ ${minutes} minutes). ` +
      `Approximate words per concept are listed in the plan — high-importance ` +
      `concepts get more explanation, medium ones a solid paragraph. ` +
      `Each segment's document MUST be one of ${JSON.stringify([...new Set(plan.concepts.map((c) => c.source))])} ` +
      `and its page MUST lie within the evidence shown for its concept.`,
    usr:
      `Teaching plan (order matters — prerequisites first):\n` +
      plan.concepts.map((c) => `  ${c.order}. ${c.title} [${c.importance}, ~${budgetOf(c)} words] — ${c.why}${c.examples?.length ? `\n     Example to explain through: ${c.examples.join('; ')}` : ''}`).join('\n') +
      `\n\nSource evidence per concept:\n<<<\n${evidence.join('\n\n') || '(no evidence)'}\n>>>${fix}`,
  };
}

// Filler detection — generic connectors only count as filler when the segment
// has no real explanation behind them (< 40 words AND matches the pattern).
const FILLER_RE = /\b(?:an?\s+example\s+(?:illustrates|demonstrates|shows)|this\s+(?:concept|topic|idea)\s+is\s+(?:very\s+)?important|these\s+(?:components|techniques|methods|parts)\s+work\s+together|as\s+(?:we|you)\s+can\s+see|in\s+summary,?\s+(?:we|it)\s+(?:can|have)\s+(?:see|learned))\b/i;
// "Substance" cue: the sentence elaborates (colon/semicolon explanation,
// for example / because / which means) rather than just naming the phrase.
const SUBSTANCE_RE = /[:;]\s*.{20,}|for example|for instance|specifically|such as|because|which means|this means/i;
export function detectFiller(segments) {
  const out = [];
  for (const s of segments) {
    const w = String(s.text).split(/\s+/).filter(Boolean).length;
    if (w < 50 && FILLER_RE.test(s.text) && !SUBSTANCE_RE.test(s.text)) {
      out.push({ segment: s.id, evidence: s.text.slice(0, 80) });
    }
  }
  return out;
}

// Spoken-math vocabulary — verbalized notation ("w zero", "sum over n"),
// math words, or digits — what TTS must actually say for an equation.
export const MATH_NARRATION_RE =
  /\b(equation|formula|variable|parameter|coefficient|derivative|gradient|squared|square root|summation|sum over|superscript|subscript|matrix|vector|multiply|multiplied|divided|slope|intercept|cost function|minimi[sz]e|optimi[sz]e|equals|times|plus|minus|sigma|theta|beta|alpha|hat|numerator|denominator|\d|zero|one|two|three)\b/i;
// Equation-bearing source evidence.
export const MATH_EVIDENCE_RE =
  /[=∑∂∇√±×÷≈≤≥]|\b(gradient|derivative|cost function|equation|summation|integral|matrix multiplication)\b/i;

// Fast gate = shared V3 validator + fast-specific shallowness/filler checks.
// opts: {targetWords, minutes, mathByBlock, teaching} — the V3 length band is
// replaced by this call's configured target so a deliberate long/short lecture
// isn't force-fit into the global default band. `teaching` (the original
// instructional inventory from loadCorpus) enables an INDEPENDENT coverage
// check — the plan's own "omitted" list is not trusted to be complete.
export function validateFast(parsed, allowedDocs, plan, opts = {}) {
  const v = validateLectureV3(parsed, allowedDocs, plan);
  const target = opts.targetWords || targetWordsFor(opts.minutes || FAST_MINUTES);
  const problems = v.problems.filter((p) => !/^too (short|long)/.test(p));
  const warnings = [...(v.warnings || [])];
  const words = (id) => parsed.segments.filter((s) => s.blockId === id)
    .reduce((n, s) => n + s.text.split(/\s+/).filter(Boolean).length, 0);
  // Duration: hard-fail a badly under-delivered script; overshoot is a
  // warning (long lectures are the reviewer's call, not a compressor's).
  if (v.words < target * 0.7) problems.push(`too short for target (${v.words}w < ${Math.round(target * 0.7)}w of ~${target}w)`);
  if (v.words > target * 1.15) warnings.push(`overshoot: ${v.words}w vs ~${target}w target`);
  // High-importance concepts need depth — under 80 words is named-not-taught.
  for (const c of plan.concepts || []) {
    if (c.importance === 'high' && words(c.blockId) < 80) {
      problems.push(`core concept "${c.title}" is under-explained (${words(c.blockId)}w < 80w)`);
    }
  }
  const filler = detectFiller(parsed.segments);
  if (filler.length) problems.push(`${filler.length} filler segment(s) (e.g. segment ${filler[0].segment})`);

  // Independent coverage check against the ORIGINAL instructional inventory —
  // a teaching section (non-admin) with no narration page inside its range was
  // silently dropped, regardless of what the plan claims.
  if (Array.isArray(opts.teaching) && opts.teaching.length) {
    const covered = parsed.segments.filter((s) => s.page != null && s.document)
      .map((s) => `${s.document}#${s.page}`);
    const coveredSet = new Set(covered);
    const uncovered = opts.teaching.filter((s) => {
      const lo = s.page_start ?? s.pageStart ?? 1;
      const hi = s.page_end ?? s.pageEnd ?? lo;
      for (let p = lo; p <= hi; p++) {
        if (coveredSet.has(`${s.filename}#${p}`)) return false;
      }
      return true;
    });
    const ratio = uncovered.length / opts.teaching.length;
    if (ratio > 0.35) {
      problems.push(`instructional coverage ${Math.round((1 - ratio) * 100)}% — ` +
        `no narration on: ${uncovered.slice(0, 5).map((s) => `"${s.title}" p.${s.page_start ?? s.pageStart}`).join(', ')}${uncovered.length > 5 ? ` (+${uncovered.length - 5} more)` : ''}`);
    } else if (uncovered.length) {
      warnings.push(`${uncovered.length} instructional slide(s) without narration: ${uncovered.slice(0, 4).map((s) => `"${s.title}" p.${s.page_start ?? s.pageStart}`).join(', ')}`);
    }
  }

  // Coverage honesty — omitted topics and a recommended longer duration are
  // reported to the reviewer, never silently dropped.
  if (plan.recommendedMinutes && plan.recommendedMinutes > (opts.minutes || FAST_MINUTES)) {
    warnings.push(`full topic coverage needs ~${plan.recommendedMinutes} min; target is ${opts.minutes || FAST_MINUTES} — omitted: ${(plan.omitted || []).join('; ') || 'none'}`);
  } else if (plan.omitted?.length) {
    warnings.push(`topics omitted from narration: ${plan.omitted.join('; ')}`);
  }

  // Per-concept math check — a block whose evidence contains equations must
  // produce narration that actually verbalizes the math, not merely exists.
  for (const [blockId, title] of Object.entries(opts.mathByBlock || {})) {
    const segs = parsed.segments.filter((s) => s.blockId === blockId);
    if (segs.length && !segs.some((s) => MATH_NARRATION_RE.test(s.text))) {
      problems.push(`concept "${title}" has equation-bearing slides but the narration never explains the math`);
    }
  }
  return { ok: !problems.length, problems, warnings, words: v.words };
}

// The model sometimes reports a page outside the concept's source range
// (observed: pages 3–4 on a 2-page PDF). Clamp to the nearest page in the
// concept's assigned range — provenance stays real, never invented — and
// record the clamp as a warning so review sees it.
export function normalizeSegmentPages(parsed, plan, corpus = null) {
  const warnings = [];
  const rangeOf = new Map(plan.concepts.map((c) => [c.blockId, c]));
  const chunksByConcept = new Map();
  const chunksFor = (c) => {
    if (!chunksByConcept.has(c.blockId)) {
      chunksByConcept.set(c.blockId,
        (corpus?.teaching || []).filter((s) => s.filename === c.source)
          .flatMap((s) => s.chunks || [])
          .filter((ch) => ch.page != null));
    }
    return chunksByConcept.get(c.blockId);
  };
  // Word-overlap score between a segment and each source chunk — used to pick
  // the BEST page inside the concept's range rather than blindly clamping to
  // the nearest edge, which only manufactures false confidence in the mapping.
  const tokenize = (t) => new Set(String(t || '').toLowerCase()
    .split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 3));
  const bestPage = (text, c, lo, hi) => {
    const cands = chunksFor(c).filter((ch) => ch.page >= lo && ch.page <= hi);
    if (!cands.length) return null;
    const toks = tokenize(text);
    if (!toks.size) return null;
    let best = null, score = 0;
    for (const ch of cands) {
      const ct = tokenize(ch.text);
      let n = 0;
      for (const w of toks) if (ct.has(w)) n++;
      const s = n / toks.size;
      if (s > score) { score = s; best = ch.page; }
    }
    return score >= 0.15 ? best : null;
  };
  for (const s of parsed.segments) {
    const c = rangeOf.get(s.blockId);
    if (!c) continue;
    const lo = Math.max(1, c.pageStart || 1);   // exact page range — not the
    const hi = c.pageEnd || c.pageStart || 1;   // ±1 evidence-search margin
    if (s.document && s.document !== c.source) {
      warnings.push(`segment ${s.id}: document "${s.document}" clamped to "${c.source}"`);
      s.document = c.source;
      s.mapped = 'auto';
    }
    if (s.page == null || s.page < lo || s.page > hi) {
      const matched = bestPage(s.text, c, lo, hi);
      const clamped = s.page == null ? lo : Math.min(hi, Math.max(lo, s.page));
      const page = matched ?? clamped;
      warnings.push(`segment ${s.id}: page ${s.page ?? '∅'} → ${page}${matched != null ? ' (content-matched)' : ''} (outside ${c.source} p.${lo}–${hi})`);
      s.page = page;
      s.mapped = 'auto';
    }
  }
  return warnings;
}

// Map each segment to its plan concept → blockId, for coverage checks.
export function assignConcepts(parsed, plan) {
  const titles = plan.concepts.map((c) => normalizeText(c.title));
  let lastIdx = -1;
  for (const s of parsed.segments) {
    const c = normalizeText(s.concept || s.section || '');
    let idx = titles.findIndex((t) => c.includes(t) || t.includes(c) && c.length > 3);
    if (idx < 0) {
      // Unlabeled — treat intro as first, recap as last, else same as previous.
      const label = `${s.section || ''} ${s.concept || ''}`;
      if (/intro|opening|welcome/i.test(label)) s.blockId = '__intro';
      else if (/recap|summary|conclusion|closing/i.test(label)) s.blockId = '__recap';
      else if (lastIdx >= 0) idx = lastIdx;
    }
    if (idx >= 0) {
      s.blockId = plan.concepts[idx].blockId;
      lastIdx = idx;
    }
    if (!s.blockId && s === parsed.segments[0]) s.blockId = '__intro';
    if (!s.blockId && s === parsed.segments.at(-1)) s.blockId = '__recap';
    if (!s.blockId) s.blockId = plan.concepts[Math.max(0, lastIdx)]?.blockId || '__intro';
  }
}

// ---- public API ---------------------------------------------------------------
export async function generateLectureFast(courseId, outlineEntry, deps = {}, opts = {}) {
  // Narration duration target — per-call option (instructor build setting)
  // overrides env defaults. 5–15 min band.
  const minutes = Math.min(15, Math.max(5, Number(opts.minutes ?? deps.minutes ?? FAST_MINUTES)));
  const targetWords = targetWordsFor(minutes);
  const meta = {
    minutes, targetWords,
    generator: GENERATOR_VERSION, promptVersion: PROMPT_VERSION,
    llmCalls: 0, promptChars: 0, blockAttempts: 0, repairedBlocks: 0,
    llmUsage: { promptTokens: 0, genTokens: 0, loadDurationMs: 0, promptEvalMs: 0, evalMs: 0, totalMs: 0 },
    model: process.env.COURSE_LLM_MODEL || 'qwen3:8b', startedAt: Date.now(),
  };
  const countedChat = async (msgs, opts) => {
    meta.llmCalls += 1;
    meta.promptChars += msgs.reduce((n, m) => n + String(m.content).length, 0);
    const r = await (deps.chat || defaultChat)(msgs, opts);
    const u = takeLlmUsage();
    if (u) {
      meta.llmUsage.promptTokens += u.promptTokens || 0;
      meta.llmUsage.genTokens += u.genTokens || 0;
      meta.llmUsage.loadDurationMs += Math.round((u.loadDurationNs || 0) / 1e6);
      meta.llmUsage.promptEvalMs += Math.round((u.promptEvalDurationNs || 0) / 1e6);
      meta.llmUsage.evalMs += Math.round((u.evalDurationNs || 0) / 1e6);
      meta.llmUsage.totalMs += Math.round((u.totalDurationNs || 0) / 1e6);
    }
    return r;
  };
  const myDeps = { ...deps, chat: countedChat };

  // Stage A — corpus (deterministic, reuses parsed sections/chunks).
  const corpus = await loadCorpus(courseId, outlineEntry, myDeps);
  if (!corpus.teaching.length) {
    throw new Error(`No educational content found for "${outlineEntry.title}"`);
  }

  // Stage B — ONE planning call, bounded retries for malformed JSON.
  let plan = null;
  let planReason = 'no attempts';
  for (let attempt = 0; attempt < 3 && !plan; attempt++) {
    const { sys, usr } = planPrompt(outlineEntry, corpus);
    try {
      const raw = await countedChat([
        { role: 'system', content: sys },
        { role: 'user', content: usr + (attempt ? `\n\nPrevious reply rejected: ${planReason}. Return ONLY the JSON.` : '') },
      ], { json: true, maxTokens: 1200 });
      const v = validatePlan(raw, corpus);
      if (v.ok) plan = v.plan; else planReason = v.reason;
    } catch (e) {
      planReason = `transport error: ${String(e.message || e).slice(0, 100)}`;
    }
  }
  if (!plan) {
    plan = fallbackPlan(outlineEntry, corpus);
    meta.planFallback = planReason;
    console.warn(`[fast] plan fallback for lecture ${outlineEntry.idx}: ${planReason}`);
  }

  // Duration feasibility — estimate the minimum words each concept needs and
  // report a recommended duration when the target can't fund full coverage.
  // The plan keeps going either way; the warning surfaces to the reviewer.
  const neededWords = 120 + plan.concepts.reduce((n, c) =>
    n + (c.importance === 'medium' ? MIN_WORDS_PER_CONCEPT.medium : MIN_WORDS_PER_CONCEPT.high), 0);
  plan.recommendedMinutes = Math.ceil(neededWords / PLAN_WPM);
  if (plan.recommendedMinutes > minutes) {
    console.warn(`[fast] lecture ${outlineEntry.idx}: ${plan.concepts.length} concepts need ~${plan.recommendedMinutes} min, target ${minutes} — reviewer sees coverage warning`);
  }

  // Shape concepts into plan.blocks (shared V3 contract for gates/repairs).
  const bodyWords = Math.max(0, targetWords - 100);
  const perConcept = Math.max(45, Math.round(bodyWords / plan.concepts.length));
  plan.blocks = plan.concepts.map((c, i) => ({
    id: `c${i + 1}`, title: c.title, role: 'core',
    budget: perConcept, teachingObjective: c.why, examples: c.examples,
    sources: [{ filename: c.source, pageStart: c.pageStart, pageEnd: c.pageEnd }],
  }));
  plan.concepts.forEach((c, i) => { c.blockId = `c${i + 1}`; });
  plan.introWords = plan.recapWords = 50;
  plan.subject = plan.objective;
  plan.omitted = plan.omitted || [];

  // Stage C — ONE narration call. Retry ≤2 on empty/malformed only.
  let parsed = null;
  let reason = 'no attempts';
  const files = [...new Set(plan.concepts.map((c) => c.source))];
  for (let attempt = 0; attempt < 3 && !parsed; attempt++) {
    const { sys, usr } = narrationPrompt(outlineEntry, plan, corpus,
      attempt ? `\n\nPrevious reply rejected: ${reason}. Return ONLY the JSON — segments must each contain ≥15 spoken words.` : '',
      { targetWords, minutes });
    let raw = null;
    try { raw = await countedChat([{ role: 'system', content: sys }, { role: 'user', content: usr }], { json: true, maxTokens: MAX_TOKENS }); }
    catch (e) { reason = `transport error: ${String(e.message || e).slice(0, 100)}`; }
    const v = validateBlockResponse(raw);
    if (!v.ok) { reason = v.reason; continue; }
    const segs = v.list.map((s) => ({
      id: -1, concept: String(s.concept || s.section || '').trim(),
      document: String(s.document || s.file || '').trim(),
      page: Number(s.page ?? s.pageNumber) || null,
      text: String(s.text || s.narration || '').replace(/\*+/g, '').replace(/\s{2,}/g, ' ').trim(),
      blockId: null,
    })).filter((s) => s.text);
    if (!segs.length) { reason = 'all segments empty or duplicate'; continue; }
    parsed = { title: cleanTitle(outlineEntry.title), segments: segs };
  }
  if (!parsed) throw new Error(`Narration failed after 3 attempts: ${reason}`);

  assignConcepts(parsed, plan);
  // Clamp any out-of-range document/page references to the concept's real
  // source range — provenance stays source-grounded, never invented.
  const provenanceWarnings = normalizeSegmentPages(parsed, plan, corpus);
  // Dedup → gap check → ONE bounded repair pass on missing/under-explained blocks.
  {
    const { segments: dd, removedIds } = dedupeSegments(parsed.segments);
    if (removedIds.length) {
      parsed.segments = dd;
      console.log(`[fast] lecture ${outlineEntry.idx}: removed ${removedIds.length} duplicate segment(s)`);
    }
  }
  const gaps = blockGaps(parsed, plan);
  // High-importance concepts under 60w are shallow even when blockGaps passes
  // them (its floor is 30w) — repair them too.
  {
    const wBy = new Map();
    for (const s of parsed.segments) {
      wBy.set(s.blockId, (wBy.get(s.blockId) || 0) + s.text.split(/\s+/).filter(Boolean).length);
    }
    for (const c of plan.concepts) {
      const w = wBy.get(c.blockId) || 0;
      const floor = c.importance === 'medium' ? 60 : 80;
      const b = plan.blocks.find((x) => x.id === c.blockId);
      // A concept must reach the higher of its per-importance floor or 60% of
      // its planned budget — under-delivery gets a targeted expansion repair,
      // not a silent pass.
      const need = Math.max(floor, Math.round((b?.budget || 120) * 0.6));
      if (w < need && !gaps.some((g) => g.blockId === c.blockId)) {
        gaps.push({ ...(b || {}), blockId: c.blockId, title: c.title,
          objective: c.why, budget: b?.budget || 120, sources: b?.sources || c.sources || [],
          reason: `under-explained (${w}w < ${need}w)` });
      }
    }
  }
  if (gaps.length) {
    const { repaired, stillMissing } = await repairGaps(parsed, plan, corpus, gaps, myDeps, meta);
    meta.repairedBlocks = repaired;
    parsed.blockFailures = stillMissing;
    const { segments: dd2, removedIds: rm2 } = dedupeSegments(parsed.segments);
    if (rm2.length) parsed.segments = dd2;
  }
  parsed.sections = segsToSections(parsed.segments);
  parsed.segments.forEach((s, i) => { s.id = i; });

  // Stage D — final integrity gate (shared V3 validator). Duration overshoot
  // compresses once; nothing else gets a second pass.
  const allowedDocs = Object.fromEntries((outlineEntry.sources || [])
    .map((s) => [s.filename, { documentId: s.documentId, pages: s.pages }]));
  // Per-concept math map — blocks whose evidence carries equations need
  // narration that actually verbalizes the math.
  const mathByBlock = {};
  for (const c of plan.concepts) {
    if (MATH_EVIDENCE_RE.test(conceptEvidence(c, corpus))) mathByBlock[c.blockId] = c.title;
  }
  const gateOpts = { targetWords, minutes, mathByBlock, teaching: corpus.teaching };
  let final = validateFast(parsed, allowedDocs, plan, gateOpts);
  if (!final.ok && final.problems.some((p) => p.startsWith('too long'))) {
    parsed = await compressOvershootV3(parsed, plan, myDeps);
    const { segments: dd3, removedIds: rm3 } = dedupeSegments(parsed.segments);
    if (rm3.length) parsed.segments = dd3;
    parsed.sections = segsToSections(parsed.segments);
    parsed.segments.forEach((s, i) => { s.id = i; });
    final = validateFast(parsed, allowedDocs, plan, gateOpts);
  }
  const warnings = [...provenanceWarnings, ...(final.warnings || [])];
  parsed.validation = final.ok
    ? (warnings.length ? { ok: true, warnings } : undefined)
    : { ok: false, problems: final.problems, warnings };
  // Coverage report for the review UI — full topic inventory + what didn't fit.
  parsed.coverage = {
    checklist: plan.concepts.map((c, i) => ({ n: i + 1, title: c.title })),
    missing: (plan.omitted || []).map((t, i) => ({ n: i + 1, title: typeof t === 'string' ? t : t?.title || String(t) })),
    ...(plan.recommendedMinutes > minutes ? { recommendedMinutes: plan.recommendedMinutes } : {}),
  };
  parsed.wordCount = parsed.segments.reduce((n, s) => n + s.text.split(/\s+/).filter(Boolean).length, 0);
  parsed.estimatedMinutes = parsed.wordCount / EFFECTIVE_WPM;
  parsed.plan = { subject: plan.objective, objective: plan.objective,
    blocks: plan.blocks, omitted: plan.omitted, degraded: !!meta.planFallback,
    recommendedMinutes: plan.recommendedMinutes };
  parsed.inventorySummary = {
    concepts: plan.concepts.map((c) => ({ title: c.title, role: 'core' })),
    excluded: corpus.excluded.map((s) => ({ title: s.title, kind: s._class?.kind || 'admin' })),
    unprocessedPages: corpus.unprocessedPages || [],
  };
  parsed.blockFailures = parsed.blockFailures || [];
  meta.wordCount = parsed.wordCount;
  meta.estimatedMinutes = parsed.estimatedMinutes;
  meta.elapsedMs = Date.now() - meta.startedAt;
  parsed.genMeta = meta;
  return parsed;
}

export { generateLectureFast as generateLecture };
