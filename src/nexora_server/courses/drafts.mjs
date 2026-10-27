// Script-review draft stage — the build pipeline stops after scripts are
// emitted; an authorised reviewer edits segment text; audio only bakes
// after explicit approval. Segment ids, document/page provenance and slide
// maps are ALWAYS preserved — only `text` may change.
//
// Edited segments invalidate their cached audio/lipsync/translation in
// every language (<lectureId> and <lectureId>__<lang>) so a post-approval
// re-bake regenerates exactly the changed parts.

import crypto from 'node:crypto';
import fs, { promises as fsp } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPool } from '../db/pool.mjs';

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROFBRAIN_DIR = path.resolve(SERVER_DIR, '../../../profbrain/lectures');
const SEGMENT_CACHE_ROOT = path.resolve(SERVER_DIR, '../../nexora_ai/lecture_cache/segments');

// Languages the app supports for narration — canonical 'en' is the master
// script; the rest are reviewable translations.
export const TRANSLATION_LANGS = ['ar', 'fr', 'de', 'es', 'zh'];

// ---------------------------------------------------------------------------
// Whole-script re-draft — the reviewer can paste a COMPLETE revised script
// (e.g. improved in ChatGPT). It is deterministically re-segmented and each
// new segment is aligned back to a source document/page:
//   1. high similarity to an OLD segment  -> reuse that mapping ('kept')
//   2. decent match to a source chunk     -> remap to that page ('auto')
//   3. nothing credible                   -> inherit previous position AND
//      flag 'uncertain' for the reviewer (never guessed silently)
// ---------------------------------------------------------------------------

const words = (t) => (t || '').toLowerCase().split(/[^a-z0-9']+/i).filter((w) => w.length > 2);
const wordSet = (t) => new Set(words(t));
// Containment of `b`'s vocabulary inside `a` — how much of the new text was
// already covered by the old segment / source chunk.
const containment = (a, bSet) => {
  const aSet = a instanceof Set ? a : wordSet(a);
  if (!bSet.size) return 0;
  let hit = 0;
  for (const w of bSet) if (aSet.has(w)) hit++;
  return hit / bSet.size;
};

// Split a pasted whole script into narration segments. Paragraph breaks are
// primary; tiny paragraphs merge forward, oversized paragraphs split at
// sentence boundaries (~60 words, ~25s of speech each).
export function splitScriptIntoSegments(fullText) {
  const paras = (fullText || '')
    .split(/\n\s*\n+/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const out = [];
  const flush = (buf) => { if (buf.trim()) out.push(buf.trim()); };
  for (const p of paras) {
    const wc = words(p).length;
    if (wc < 12) {                 // tiny — carry into the next segment
      out.push(p);                 // temporarily separate; merged below
      continue;
    }
    if (wc <= 100) { out.push(p); continue; }
    // Oversized paragraph — cut at sentence ends into ~60-word pieces.
    const sentences = p.match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g) || [p];
    let buf = '';
    for (const s of sentences) {
      if (words(buf).length >= 60 && words(s).length >= 10) { flush(buf); buf = ''; }
      buf = `${buf} ${s}`.trim();
    }
    flush(buf);
  }
  // Merge micro-segments forward (except a trailing micro stays put).
  const merged = [];
  for (let i = 0; i < out.length; i++) {
    if (words(out[i]).length < 12 && i + 1 < out.length) {
      out[i + 1] = `${out[i]} ${out[i + 1]}`;
    } else {
      merged.push(out[i]);
    }
  }
  return merged;
}

// Align new segment texts to source mappings.
//   oldSegments: previous segments.json entries (document/documentId/page/section)
//   chunks:      course_chunks rows { text, page, heading, filename, document_id }
// Returns [{ text, document, documentId, page, section, mapped }] where
// mapped is 'kept' | 'auto' | 'uncertain'.
export function alignSegments(newTexts, oldSegments, chunks) {
  const oldSets = (oldSegments || []).map((s) => wordSet(s.text));
  const chunkSets = (chunks || []).map((c) => wordSet(c.text));
  const result = [];
  for (const text of newTexts) {
    const tSet = wordSet(text);
    let best = { kind: null, score: 0 };
    oldSets.forEach((oSet, i) => {
      const s = containment(tSet, oSet);       // how much old text survived
      if (s > best.score) best = { kind: 'old', i, score: s };
    });
    if (best.kind === 'old' && best.score >= 0.55) {
      const o = oldSegments[best.i];
      result.push({ text, document: o.document, documentId: o.documentId,
        page: o.page, section: o.section || 'Lecture', mapped: 'kept' });
      continue;
    }
    best = { kind: null, score: 0 };
    chunkSets.forEach((cSet, i) => {
      const s = containment(cSet, tSet); // how much of the new text the chunk covers
      if (s > best.score) best = { kind: 'chunk', i, score: s };
    });
    if (best.kind === 'chunk' && best.score >= 0.35) {
      const c = chunks[best.i];
      result.push({ text, document: c.filename, documentId: c.document_id,
        page: c.page, section: c.heading || 'Lecture',
        mapped: best.score >= 0.5 ? 'auto' : 'uncertain' });
      continue;
    }
    // No credible match — inherit the previous position (narration usually
    // continues on the same spread) and FLAG it; never pretend it's certain.
    const prev = result[result.length - 1] || oldSegments?.[0] || {};
    result.push({ text, document: prev.document || null,
      documentId: prev.documentId || null, page: prev.page ?? null,
      section: prev.section || 'Lecture', mapped: 'uncertain' });
  }
  return result;
}

// Lightweight pre-TTS validation of a revised script (the generator's
// stricter check already ran at emit; this guards reviewer edits).
export function validateDraftScript(segments) {
  const problems = [];
  if (!segments.length) problems.push('script is empty');
  const total = segments.reduce((n, s) => n + words(s.text).length, 0);
  if (total < 80) problems.push(`script too short (${total} words)`);
  if (total > 1500) problems.push(`script too long (${total} words)`);
  const empty = segments.filter((s) => !s.text.trim()).length;
  if (empty) problems.push(`${empty} empty segment(s)`);
  return { ok: problems.length === 0, problems };
}

// Pure: apply reviewer text edits to a segments.json payload.
// edits = [{ index, text }] — must cover every segment exactly once, each
// with non-empty text. Returns { ok, segments, changedIndexes, error }.
export function applyDraftEdits(segmentsJson, edits) {
  const segs = segmentsJson?.segments;
  if (!Array.isArray(segs) || !segs.length) {
    return { ok: false, error: 'lecture has no segments' };
  }
  if (!Array.isArray(edits) || edits.length !== segs.length) {
    return { ok: false, error: `expected ${segs.length} segment texts, got ${edits?.length ?? 0}` };
  }
  const byIndex = new Map(edits.map((e) => [e.index, e.text]));
  const changedIndexes = [];
  const segments = segs.map((s, i) => {
    const text = byIndex.get(s.id ?? i);
    if (typeof text !== 'string' || !text.trim()) {
      throw new Error(`segment ${s.id ?? i} text is empty`);
    }
    const clean = text.trim();
    if (clean !== s.text) changedIndexes.push(s.id ?? i);
    // Everything except `text` is immutable — ids, document, page,
    // documentId and ordering survive untouched.
    return { ...s, text: clean };
  });
  return { ok: true, segments, changedIndexes };
}

// sha256 over segment id + text — used to detect post-approval edits and
// mark baked audio outdated.
export function scriptFingerprint(segments) {
  return crypto.createHash('sha256')
    .update((segments || []).map((s) => `${s.id}:${s.text}`).join('\n'))
    .digest('hex')
    .slice(0, 16);
}

// Load the reviewable draft for one generated lecture.
export async function loadLectureDraft(lectureId) {
  const segsPath = path.join(PROFBRAIN_DIR, lectureId, 'segments.json');
  if (!fs.existsSync(segsPath)) return null;
  const parsed = JSON.parse(await fsp.readFile(segsPath, 'utf-8'));
  return {
    lectureId,
    title: parsed.title || lectureId,
    course: parsed.course || null,
    version: parsed.version || 0,
    segments: (parsed.segments || []).map((s, i) => ({
      index: s.id ?? i,
      text: s.text,
      page: s.page ?? null,
      document: s.document || null,
      documentId: s.documentId || null,
      mapped: s.mapped || null,
    })),
  };
}

// Persist reviewer edits — rewrites segments.json, summary.json and
// lecture_notes.txt in place. Returns { ok, changedIndexes, error }.
export async function saveLectureDraft(courseId, lectureId, edits) {
  const dir = path.join(PROFBRAIN_DIR, lectureId);
  const segsPath = path.join(dir, 'segments.json');
  if (!fs.existsSync(segsPath)) return { ok: false, error: 'draft not found' };
  const parsed = JSON.parse(await fsp.readFile(segsPath, 'utf-8'));
  let applied;
  try {
    applied = applyDraftEdits(parsed, edits);
  } catch (err) {
    return { ok: false, error: err.message };
  }
  if (!applied.ok) return applied;
  parsed.segments = applied.segments;
  parsed.version = (parsed.version || 0) + 1;  // bump on every canonical edit
  await fsp.writeFile(segsPath, JSON.stringify(parsed, null, 2));

  const narration = applied.segments.map((s) => s.text).join('\n\n');
  await fsp.writeFile(path.join(dir, 'summary.json'), JSON.stringify({
    lecture_id: lectureId, title: parsed.title, text: narration,
    word_count: narration.split(/\s+/).length,
    model: 'generated', generated: true, reviewed: true,
    created_at: new Date().toISOString(),
  }, null, 2));
  // Notes regroup by the segments' own section labels — titles preserved.
  const bySection = new Map();
  for (const s of applied.segments) {
    const key = s.section || 'Lecture';
    if (!bySection.has(key)) bySection.set(key, []);
    bySection.get(key).push(s.text);
  }
  await fsp.writeFile(path.join(dir, 'lecture_notes.txt'),
    [...bySection].map(([t, texts]) => `${t}\n${texts.join('\n\n')}`).join('\n\n'));

  return { ok: true, changedIndexes: applied.changedIndexes };
}

// Whole-script save — the reviewer pasted one complete revised script.
// Re-segment, align each segment to a document/page, rebuild every artifact
// (segments.json, summary.json, lecture_notes.txt, lecture_plan.json,
// slide_map.json), invalidate affected audio, and report uncertainty.
// Returns { ok, error?, segments, changedIndexes, uncertainIndexes, validation }.
export async function saveLectureFullDraft(courseId, lectureId, fullText) {
  const dir = path.join(PROFBRAIN_DIR, lectureId);
  const segsPath = path.join(dir, 'segments.json');
  if (!fs.existsSync(segsPath)) return { ok: false, error: 'draft not found' };
  const parsed = JSON.parse(await fsp.readFile(segsPath, 'utf-8'));
  const oldSegments = parsed.segments || [];

  const texts = splitScriptIntoSegments(fullText);
  if (!texts.length) return { ok: false, error: 'script is empty' };

  // Source chunks for remapping — lexical overlap, no model calls.
  const { rows: chunks } = await getPool().query(
    `SELECT c.text, c.page, c.heading, c.document_id, d.filename
       FROM course_chunks c JOIN course_documents d ON d.id = c.document_id
      WHERE c.course_id=$1`, [courseId]);

  const aligned = alignSegments(texts, oldSegments, chunks);
  const segments = aligned.map((a, i) => ({
    id: i, section: a.section, documentId: a.documentId,
    document: a.document, page: a.page, text: a.text, mapped: a.mapped,
  }));
  const validation = validateDraftScript(segments);

  // Which positions actually changed? Position-wise compare; count changes
  // count as changed (audio for the tail is stale regardless).
  const changedIndexes = segments
    .map((s, i) => (oldSegments[i]?.text !== s.text ? i : -1))
    .filter((i) => i >= 0);
  const uncertainIndexes = segments.filter((s) => s.mapped === 'uncertain').map((s) => s.id);

  parsed.segments = segments;
  parsed.version = (parsed.version || 0) + 1;  // bump on every canonical edit
  await fsp.writeFile(segsPath, JSON.stringify(parsed, null, 2));

  const narration = segments.map((s) => s.text).join('\n\n');
  await fsp.writeFile(path.join(dir, 'summary.json'), JSON.stringify({
    lecture_id: lectureId, title: parsed.title, text: narration,
    word_count: narration.split(/\s+/).filter(Boolean).length,
    model: 'generated', generated: true, reviewed: true,
    created_at: new Date().toISOString(),
  }, null, 2));
  const bySection = new Map();
  for (const s of segments) {
    const key = s.section || 'Lecture';
    if (!bySection.has(key)) bySection.set(key, []);
    bySection.get(key).push(s.text);
  }
  await fsp.writeFile(path.join(dir, 'lecture_notes.txt'),
    [...bySection].map(([t, ts]) => `${t}\n${ts.join('\n\n')}`).join('\n\n'));

  // Rebuild topics from contiguous section runs — transitions announce the
  // right title and slidePages stay consistent with the new mappings.
  const topics = [];
  for (const s of segments) {
    const key = s.section || 'Lecture';
    const last = topics[topics.length - 1];
    if (last && last.title === key) {
      last.segmentIds.push(s.id);
      if (s.page) last.slidePages.push(s.page);
    } else {
      topics.push({ id: `t${topics.length}`, title: key, segmentIds: [s.id],
        slidePages: s.page ? [s.page] : [] });
    }
  }
  await fsp.writeFile(path.join(dir, 'lecture_plan.json'),
    JSON.stringify({ lectureId, title: parsed.title, topics }, null, 2));

  // Slide map — keep the document table; rebuild the per-segment page refs.
  const smPath = path.join(dir, 'slide_map.json');
  let sm = { documents: {}, segments: {} };
  try { sm = JSON.parse(await fsp.readFile(smPath, 'utf-8')); } catch { /* keep defaults */ }
  sm.segments = Object.fromEntries(
    segments.map((s) => [String(s.id), { doc: s.documentId, page: s.page }]));
  await fsp.writeFile(smPath, JSON.stringify(sm, null, 2));

  return { ok: true, segments, changedIndexes, uncertainIndexes, validation };
}

// Delete cached audio/lipsync/translation for the changed segments in EVERY
// language bucket (<lid> and <lid>__<lang>) — post-approval edits mark the
// old audio outdated so the re-bake regenerates it.
export async function invalidateSegmentAudio(lectureId, changedIndexes, lang = null) {
  if (!changedIndexes?.length) return 0;
  let removed = 0;
  let dirs = [];
  try { dirs = await fsp.readdir(SEGMENT_CACHE_ROOT); } catch { return 0; }
  const buckets = lang
    ? dirs.filter((d) => d === `${lectureId}__${lang}`)
    : dirs.filter((d) => d === lectureId || d.startsWith(`${lectureId}__`));
  for (const bucket of buckets) {
    for (const idx of changedIndexes) {
      const base = `segment_${String(idx).padStart(3, '0')}`;
      for (const file of [`${base}.wav`, `${base}_lipsync.json`, `${base}.txt`]) {
        try {
          await fsp.unlink(path.join(SEGMENT_CACHE_ROOT, bucket, file));
          removed++;
        } catch { /* absent — fine */ }
      }
    }
  }
  return removed;
}

// ---------------------------------------------------------------------------
// Per-language drafts — translations/<lang>.json is the reviewable canonical
// text for that language: {lang, version, basedOnVersion, fingerprint,
// edited, segments:[{id,text}]}. Editing the canonical bumps its version and
// marks every translation 'outdated' (stale base) WITHOUT touching the
// reviewer's text — edits are never silently overwritten.
// ---------------------------------------------------------------------------

const transPath = (lectureId, lang) =>
  path.join(PROFBRAIN_DIR, lectureId, 'translations', `${lang}.json`);

export async function canonicalVersion(lectureId) {
  try {
    const p = JSON.parse(await fsp.readFile(
      path.join(PROFBRAIN_DIR, lectureId, 'segments.json'), 'utf-8'));
    return p.version || 0;
  } catch { return 0; }
}

export async function loadLectureLangDraft(lectureId, lang) {
  try {
    const p = JSON.parse(await fsp.readFile(transPath(lectureId, lang), 'utf-8'));
    return { lectureId, lang, ...p };
  } catch { return null; }
}

// Translate the canonical script into every supported language.
// Skips languages that have human edits (edited:true) — never overwrites a
// reviewer's text. Returns per-lang status.
export async function prepareTranslations(courseId) {
  const { rows } = await getPool().query(
    `SELECT lecture_id FROM course_lectures WHERE course_id=$1
       AND COALESCE(artifacts->'script','0'::jsonb)::text='1' ORDER BY idx`, [courseId]);
  const { translateForLecture } = await import('../../nexora_ai/routes/lectureRoutes.mjs');
  const report = [];
  for (const { lecture_id: lid } of rows) {
    const segsPath = path.join(PROFBRAIN_DIR, lid, 'segments.json');
    if (!fs.existsSync(segsPath)) continue;
    const parsed = JSON.parse(await fsp.readFile(segsPath, 'utf-8'));
    const version = parsed.version || 0;
    await fsp.mkdir(path.dirname(transPath(lid, 'ar')), { recursive: true });
    for (const lang of TRANSLATION_LANGS) {
      const existing = await loadLectureLangDraft(lid, lang);
      if (existing?.edited) {
        report.push({ lectureId: lid, lang, status: 'kept-reviewed' });
        continue;
      }
      const segments = [];
      let failed = false;
      for (const s of parsed.segments) {
        try {
          const t = await translateForLecture(s.text, lang);
          segments.push({ id: s.id, text: t });
        } catch (e) {
          failed = true;
          report.push({ lectureId: lid, lang, status: 'failed', error: e.message });
          break;
        }
      }
      if (failed) continue;
      const fingerprint = scriptFingerprint(segments);
      const payload = { lang, lectureId: lid, version, basedOnVersion: version,
        fingerprint, edited: false, segments };
      await fsp.writeFile(transPath(lid, lang), JSON.stringify(payload, null, 2));
      // Mirror into the runtime text cache so audio bakes this exact text.
      const cacheDir = path.join(SEGMENT_CACHE_ROOT, `${lid}__${lang}`);
      await fsp.mkdir(cacheDir, { recursive: true });
      for (const s of segments) {
        await fsp.writeFile(path.join(cacheDir,
          `segment_${String(s.id).padStart(3, '0')}.txt`), s.text).catch(() => {});
      }
      report.push({ lectureId: lid, lang, status: 'ready', version });
    }
  }
  return report;
}

// Save a reviewer's edited translation — FREE-FORM. The pasted script is
// re-split, then each new segment is aligned back to a canonical segment id
// (which carries document/page) by lexical containment — mirroring
// alignSegments: strong match -> canonical id + page ('kept'), weak match ->
// inherit positional neighbour and flag 'uncertain' (never silently guessed).
export function alignLangSegments(newTexts, canonical) {
  const canonSets = canonical.map((s) => wordSet(s.text));
  const out = [];
  for (const text of newTexts) {
    const tSet = wordSet(text);
    let best = { i: -1, score: 0 };
    canonSets.forEach((cSet, i) => {
      const s = containment(cSet, tSet);   // how much of the new text the canonical segment covers
      if (s > best.score) best = { i, score: s };
    });
    if (best.i >= 0 && best.score >= 0.5) {
      out.push({ id: canonical[best.i].id, text, mapped: 'kept' });
    } else {
      const prev = out[out.length - 1];
      const nextId = prev ? prev.id + 1 : 0;
      out.push({ id: Math.min(nextId, canonical[canonical.length - 1]?.id ?? 0),
        text, mapped: 'uncertain' });
    }
  }
  return out;
}

export async function saveLectureLangDraft(courseId, lectureId, lang, fullText) {
  const parsed = JSON.parse(await fsp.readFile(
    path.join(PROFBRAIN_DIR, lectureId, 'segments.json'), 'utf-8'));
  const canonical = parsed.segments || [];
  const texts = splitScriptIntoSegments(fullText);
  if (!texts.length) return { ok: false, error: 'empty translation' };
  const aligned = alignLangSegments(texts, canonical);
  const segments = aligned.map((a) => ({ id: a.id, text: a.text }));
  const uncertainIndexes = aligned.filter((a) => a.mapped === 'uncertain').map((a) => a.id);
  const existing = await loadLectureLangDraft(lectureId, lang);
  const changedIndexes = segments
    .filter((s) => !existing?.segments?.find((x) => x.id === s.id && x.text === s.text))
    .map((s) => s.id);
  const payload = { lang, lectureId, version: parsed.version || 0,
    basedOnVersion: parsed.version || 0,
    fingerprint: scriptFingerprint(segments), edited: true,
    uncertainIndexes, segments };
  await fsp.mkdir(path.dirname(transPath(lectureId, lang)), { recursive: true });
  await fsp.writeFile(transPath(lectureId, lang), JSON.stringify(payload, null, 2));
  // Invalidate stale audio for changed segments FIRST — then mirror the new
  // text into the runtime cache (order matters: invalidation deletes .txt).
  await invalidateSegmentAudio(lectureId, changedIndexes, lang);
  const cacheDir = path.join(SEGMENT_CACHE_ROOT, `${lectureId}__${lang}`);
  await fsp.mkdir(cacheDir, { recursive: true });
  for (const s of segments) {
    await fsp.writeFile(path.join(cacheDir,
      `segment_${String(s.id).padStart(3, '0')}.txt`), s.text).catch(() => {});
  }
  return { ok: true, changedIndexes, fingerprint: payload.fingerprint, uncertainIndexes };
}

// Fingerprint of the exact text TTS will bake for (lecture,lang) — used by
// the audio gate to refuse mismatched script/audio pairs.
export async function textFingerprintForBake(lectureId, lang) {
  if (lang === 'en') {
    const p = JSON.parse(await fsp.readFile(
      path.join(PROFBRAIN_DIR, lectureId, 'segments.json'), 'utf-8'));
    return scriptFingerprint(p.segments);
  }
  const t = await loadLectureLangDraft(lectureId, lang);
  if (!t) return null;
  return scriptFingerprint(t.segments);
}

// Server-side audio approval gate — pure, unit-testable.
//   drafts:    {lectureId -> {version, segments:[{mapped}]}} canonical
//   langDocs:  {lectureId -> {lang -> translation doc}}
//   langs:     languages the instructor selected for audio
//   opts.confirmUncertain: reviewer explicitly confirmed flagged alignments
// Every selected language must have a script whose basedOnVersion matches
// the CURRENT canonical version — stale translations block until re-reviewed.
// Uncertain page/segment alignments are NON-BLOCKING warnings: an in-range,
// low-confidence mapping may be imperfect but never blocks audio when the
// approved narration itself is valid. Unresolved segments fall back to a
// safe slide at runtime; the 'uncertain' flag is preserved for review.
// Only missing scripts and stale translation versions block.
export function audioApprovalGate(drafts, langDocs, langs, { confirmUncertain = false } = {}) {
  const blocked = [];
  const warnings = [];
  for (const [lectureId, d] of Object.entries(drafts)) {
    if (!d) { blocked.push(`${lectureId}: missing canonical script`); continue; }
    const enUncertain = (d.segments || []).filter((s) => s.mapped === 'uncertain').length;
    if (enUncertain) warnings.push(`${lectureId}/en: ${enUncertain} segment(s) on fallback slide (uncertain page mapping)`);
    for (const lang of langs) {
      if (lang === 'en') continue;
      const t = langDocs[lectureId]?.[lang];
      if (!t) { blocked.push(`${lectureId}/${lang}: no script for this language`); continue; }
      if ((t.basedOnVersion ?? -1) !== (d.version ?? 0)) {
        blocked.push(`${lectureId}/${lang}: outdated (based on script v${t.basedOnVersion ?? '?'}, current v${d.version ?? 0}) — re-review`);
      }
      if ((t.uncertainIndexes || []).length) {
        warnings.push(`${lectureId}/${lang}: ${t.uncertainIndexes.length} segment(s) on fallback slide`);
      }
    }
  }
  return { ok: !blocked.length, blocked, warnings };
}
