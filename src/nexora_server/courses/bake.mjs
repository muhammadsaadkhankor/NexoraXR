// Phase 5 — pre-bake narration audio per segment through the EXACT runtime
// path (generateSegmentAudio from nexora_ai/routes/lectureRoutes.mjs) so
// prepared lectures hit cache on first play: no LLM, no TTS, no waiting.
// Lipsync is computed client-side in realtime from the audio signal — the
// _lipsync.json artifact is an optional marker the runtime tolerates.

import path from 'node:path';
import fsp from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getPool } from '../db/pool.mjs';
import { generateSegmentAudio, loadLectureManifest, generateLectureUtterance } from '../../nexora_ai/routes/lectureRoutes.mjs';
import { wavDurationMs } from '../../nexora_ai/modules/audioUtils.mjs';
import { execCommand } from '../../nexora_ai/utils/files.mjs';

const AI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'nexora_ai');
const SEG_CACHE = path.join(AI_DIR, 'lecture_cache', 'segments');
const IMG_CACHE = path.join(AI_DIR, 'lecture_cache');
const PROFBRAIN_DIR = path.resolve(AI_DIR, '..', '..', 'profbrain', 'lectures');

const CONCURRENCY = Number(process.env.COURSE_TTS_CONCURRENCY || 2);
// Required narration-duration band in SECONDS — real audio is measured, not
// estimated. Max is configurable up to 20 min (COURSE_AUDIO_MAX_S=1200) —
// longer reviewed scripts are legitimate, never a reason to discard them.
// A lecture outside it fails the build.
export const AUDIO_MIN_S = Number(process.env.COURSE_AUDIO_MIN_S || 240);
export const AUDIO_MAX_S = Math.min(1800, Number(process.env.COURSE_AUDIO_MAX_S || 1200));
export const audioOnTarget = (durationMs) =>
  durationMs >= AUDIO_MIN_S * 1000 && durationMs <= AUDIO_MAX_S * 1000;

// Language-specific cache keys mirror runtime: 'en' → <id>, others → <id>__<lang>.
const cacheKey = (lecId, lang) => (lang === 'en' ? lecId : `${lecId}__${lang}`);
const audioPath = (lecId, i, lang = 'en') =>
  path.join(SEG_CACHE, cacheKey(lecId, lang), `segment_${String(i).padStart(3, '0')}.wav`);
const lipsyncPath = (lecId, i, lang = 'en') =>
  path.join(SEG_CACHE, cacheKey(lecId, lang), `segment_${String(i).padStart(3, '0')}_lipsync.json`);

// Fail fast when the TTS service is down instead of 3-retry-per-segment.
async function ttsReachable() {
  const base = (process.env.VOXCPM_BASE_URL || 'http://localhost:8010').replace(/\/$/, '');
  try {
    const r = await fetch(base, { signal: AbortSignal.timeout(3000) });
    return r.status > 0;
  } catch { return false; }
}

const segTextPath = (lecId, i, lang = 'en') =>
  path.join(SEG_CACHE, cacheKey(lecId, lang), `segment_${String(i).padStart(3, '0')}.txt`);

const segDurationMs = async (lecId, i, lang) => {
  try { return wavDurationMs(await fsp.readFile(audioPath(lecId, i, lang))); }
  catch { return null; }
};

// Per-language narration pace differs — a translated clip that is far
// shorter than the English segment is usually truncated synthesis, far
// longer is usually a repetition loop. Ratios outside the band get ONE
// re-bake; still bad → the segment is failed (wav removed) so the
// instructor sees it and the readiness gate keeps the room off that
// language. Band is env-tunable; calibrate from COURSE_DUR_RATIO_*.
export const DUR_RATIO_MIN = Number(process.env.COURSE_DUR_RATIO_MIN || 0.6);
export const DUR_RATIO_MAX = Number(process.env.COURSE_DUR_RATIO_MAX || 1.7);

// Compare every segment's duration in `lang` against its English twin.
// Returns { ratios: {idx: ratio}, flagged: [{idx, ratio}] } — flagged
// segments failed even after the single re-bake.
export async function checkDurationRatios(lectureId, lang, segIds) {
  const band = durationRatioBand(lang, { min: DUR_RATIO_MIN, max: DUR_RATIO_MAX });
  const ratios = {};
  const flagged = [];
  for (const i of segIds) {
    const enMs = await segDurationMs(lectureId, i, 'en');
    let ms = await segDurationMs(lectureId, i, lang);
    if (!enMs || !ms) continue;
    let ratio = ms / enMs;
    if (ratio < band.min || ratio > band.max) {
      console.warn(`[bake] duration off-ratio ${lectureId}/${lang} seg=${i} ` +
        `ratio=${ratio.toFixed(2)} (en ${(enMs / 1000).toFixed(1)}s vs ${(ms / 1000).toFixed(1)}s) — re-baking once`);
      await fsp.rm(audioPath(lectureId, i, lang), { force: true }).catch(() => {});
      await fsp.rm(lipsyncPath(lectureId, i, lang), { force: true }).catch(() => {});
      const txt = await fsp.readFile(segTextPath(lectureId, i, lang), 'utf-8').catch(() => null);
      if (txt) {
        try { await generateSegmentAudio(cacheKey(lectureId, lang), i, txt, lang); }
        catch (e) { console.warn(`[bake] re-bake failed ${lectureId}/${lang} seg=${i}:`, e.message.slice(0, 120)); }
      }
      ms = await segDurationMs(lectureId, i, lang);
      ratio = ms && enMs ? ms / enMs : 0;
    }
    ratios[i] = Number(ratio.toFixed(2));
    if (ratio < band.min || ratio > band.max) {
      flagged.push({ idx: i, ratio: Number(ratio.toFixed(2)) });
      // A failed segment must not play — remove the wav so the readiness
      // gate reports the language incomplete instead of airing bad audio.
      await fsp.rm(audioPath(lectureId, i, lang), { force: true }).catch(() => {});
    }
  }
  return { ratios, flagged };
}

// Bake one lecture: manifest → per-segment audio + lipsync marker + duration.
// Returns {segments, durationMs, durationMin, segmentMs} or throws on
// unbakeable lecture.
export async function bakeLecture(lectureId, lang = 'en') {
  const manifest = await loadLectureManifest(lectureId, lang);
  const segments = manifest.segments || [];
  if (!segments.length) throw new Error(`No segments for ${lectureId}`);

  let totalMs = 0;
  const segmentMs = {};
  const missing = [];
  // Bounded concurrency — local TTS shouldn't be hammered.
  for (let i = 0; i < segments.length; i += CONCURRENCY) {
    const batch = segments.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async (seg, j) => {
      const idx = seg.id ?? i + j;
      try {
        // Never bake English source text into a non-English bucket — the
        // manifest marks untranslated segments pendingTranslation; the
        // language fails instead of silently airing English.
        if (seg.pendingTranslation) {
          missing.push({ idx, error: 'no translated text (translation stage incomplete)' });
          return;
        }
        const p = audioPath(lectureId, idx, lang);
        // generateSegmentAudio derives dir + lang FROM the id — pass the
        // lang-keyed cacheKey (gen_L1__ar), not the base lectureId, or
        // non-English audio lands in the English cache (and clobbers it).
        if (!existsSync(p)) await generateSegmentAudio(cacheKey(lectureId, lang), idx, seg.text, lang);
        const wav = await fsp.readFile(p);
        totalMs += wavDurationMs(wav);
        segmentMs[idx] = wavDurationMs(wav);
        // Marker artifact — provenance + duration metadata.
        await fsp.writeFile(lipsyncPath(lectureId, idx, lang), JSON.stringify({
          baked: true, segment: idx, lang, durationMs: wavDurationMs(wav),
          at: new Date().toISOString(),
        }));
      } catch (e) {
        missing.push({ idx, error: String(e.message || e).slice(0, 200) });
      }
    }));
  }
  if (missing.length) {
    throw new Error(`${missing.length}/${segments.length} segments failed: ${missing[0].error}`);
  }
  return { segments: segments.length, durationMs: totalMs, durationMin: totalMs / 60000, segmentMs };
}

// Pre-render every (doc,page) the lecture will show into the pdf_image render
// cache — the first-play render otherwise costs ~1-2s at every slide change.
// Cache key + filename conventions mirror the /lecture/pdf_image route
// (which is called with no `course` param → 'Multimedia').
async function warmLectureSlides(lectureId) {
  const manifest = await loadLectureManifest(lectureId, 'en');
  const slidesDir = path.join(PROFBRAIN_DIR, lectureId, 'slides');
  const byDoc = new Map();
  for (const seg of manifest.segments) {
    const doc = seg.slideDoc || null;
    if (!byDoc.has(doc)) byDoc.set(doc, new Set());
    if (seg.slidePage) byDoc.get(doc).add(seg.slidePage);
  }
  for (const [doc, pages] of byDoc) {
    const docSafe = doc ? doc.replace(/[^a-zA-Z0-9._-]/g, '_') : null;
    const pdfPath = docSafe ? path.join(slidesDir, docSafe) : path.join(PROFBRAIN_DIR, lectureId, 'slides.pdf');
    const fallback = path.join(slidesDir, docSafe || 'source.pdf');
    const source = existsSync(pdfPath) ? pdfPath : (existsSync(fallback) ? fallback : null);
    if (!source) continue;
    const docKey = docSafe ? `_${docSafe.replace(/\.pdf$/i, '')}` : '';
    for (const page of pages) {
      const outPath = path.join(IMG_CACHE, `Multimedia_${lectureId}${docKey}_slide${page > 1 ? '_p' + page : ''}.png`);
      if (existsSync(outPath)) continue;
      try {
        await execCommand({ command:
          `pdftoppm -png -f ${page} -l ${page} -r 96 -singlefile "${source}" "${outPath.replace(/\.png$/, '')}"` });
      } catch (e) {
        console.warn(`[bake] slide warm ${lectureId}/${doc}:${page}:`, e.message.slice(0, 120));
      }
    }
  }
}

// Pre-generate the deterministic dynamic utterances the agent will speak —
// opening, one transition per subsequent topic, closing recap — keyed exactly
// as the runtime generates them, so classroom playback hits cache with no
// Ollama/TTS call at every topic boundary.
async function warmLectureUtterances(lectureId, lang) {
  const { plannedUtteranceCalls } = await import('../../nexora_ai/routes/lectureRoutes.mjs');
  const manifest = await loadLectureManifest(lectureId, lang);
  const calls = await plannedUtteranceCalls(lectureId, manifest);
  const failed = [];
  for (const c of calls) {
    try {
      await generateLectureUtterance({ lectureId, language: lang, ...c });
    } catch (e) {
      console.warn(`[bake] utterance warm ${lectureId}/${lang}/${c.purpose}:`, e.message.slice(0, 120));
      failed.push(c.purpose);
    }
  }
  return failed;
}

// Languages baked ahead of time — instructor selects which; the default is
// only the teaching language (fast path). Legacy callers with no selection
// fall back to COURSE_BAKE_LANGS (env, default all) so older flows work.
import { LANGUAGE_CODES, durationRatioBand } from '../../shared/languages.mjs';
const BAKE_LANGS = (process.env.COURSE_BAKE_LANGS || LANGUAGE_CODES.join(','))
  .split(',').map((s) => s.trim()).filter(Boolean);

// Verify a whole course: every lecture has complete audio in the selected
// languages. Per-language timings are recorded in the returned report.
export async function verifyCourseAudio(courseId, langs = null, onProgress = null) {
  const langList = Array.isArray(langs) && langs.length ? langs : BAKE_LANGS;
  if (!(await ttsReachable())) {
    throw new Error(`TTS service unreachable at ${process.env.VOXCPM_BASE_URL || 'http://localhost:8010'} — start VoxCPM2 and rebuild`);
  }
  const { rows } = await getPool().query(
    `SELECT idx, lecture_id, title FROM course_lectures
      WHERE course_id=$1 AND COALESCE(artifacts->'script','0'::jsonb)::text = '1' ORDER BY idx`, [courseId]);
  const report = [];
  const timings = {};
  let lecIdx = 0;
  for (const l of rows) {
    lecIdx += 1;
    const langsDone = [], errs = [];
    for (const lang of langList) {
      const t0 = Date.now();
      onProgress?.(`lecture ${lecIdx}/${rows.length} · ${lang.toUpperCase()}`);
      try {
        const r = await bakeLecture(l.lecture_id, lang);
        const uttFailed = await warmLectureUtterances(l.lecture_id, lang);
        if (uttFailed.length) {
          errs.push(`${lang}: ${uttFailed.length} utterance(s) not baked (${uttFailed.join(',')})`);
        }
        langsDone.push(lang);
        timings[`${l.lecture_id}@${lang}`] = Date.now() - t0;
        if (lang !== 'en') {
          // Duration check for EVERY language — the English duration check
          // alone let truncated/degenerate non-English clips through.
          const { ratios, flagged } = await checkDurationRatios(
            l.lecture_id, lang, Object.keys(r.segmentMs).map(Number));
          timings[`ratios:${l.lecture_id}@${lang}`] = ratios;
          if (flagged.length) {
            const band = durationRatioBand(lang, { min: DUR_RATIO_MIN, max: DUR_RATIO_MAX });
            errs.push(`${lang}: ${flagged.length} segment(s) outside ` +
              `${band.min}–${band.max} duration band ` +
              `(${flagged.map((f) => `seg${f.idx}@${f.ratio}`).join(',')})`);
            await getPool().query(
              `UPDATE course_lectures SET artifacts = artifacts ||
                 jsonb_build_object('duration_flags',
                   COALESCE(artifacts->'duration_flags','{}'::jsonb) || $2::jsonb)
               WHERE lecture_id=$1`,
              [l.lecture_id, JSON.stringify({ [lang]: flagged })]);
          }
        }
        if (lang === 'en') {
          const onTarget = audioOnTarget(r.durationMs);
          const entry = { idx: l.idx, lectureId: l.lecture_id, title: l.title, ...r, onTarget, timings };
          // Out-of-band audio is a build-level failure — blocks publication.
          if (!onTarget) {
            entry.error = `duration ${r.durationMin.toFixed(1)}m outside ` +
              `${(AUDIO_MIN_S / 60).toFixed(1)}–${(AUDIO_MAX_S / 60).toFixed(1)}m band`;
          }
          report.push(entry);
          // Heal scripts whose validation was poisoned by an earlier bake
          // (duration wrote ok:false into artifacts.validation). A bake-only
          // failure signature gets cleared once audio passes; real script
          // problems are never touched.
          const { rows: [cur] } = await getPool().query(
            `SELECT artifacts FROM course_lectures WHERE lecture_id=$1`, [l.lecture_id]);
          const bakePoisoned = cur?.artifacts?.validation?.ok === false &&
            (cur.artifacts.validation.problems || []).length > 0 &&
            cur.artifacts.validation.problems.every((p) => /duration .* outside .*band|segments failed|TTS service/i.test(String(p)));
          await getPool().query(
            `UPDATE course_lectures SET artifacts = artifacts || $2 WHERE lecture_id=$1`,
            [l.lecture_id, JSON.stringify({
              audio: 1, duration_s: Math.round(r.durationMs / 1000), segments: r.segments,
              // Audio duration is NOT script validation — an off-target bake
              // must never poison the reviewed script's approval gate. Track
              // it separately so the retry path stays open.
              ...(onTarget
                ? { audio_offtarget: null, ...(bakePoisoned ? { validation: { ok: true } } : {}) }
                : { audio_offtarget: entry.error }),
            })]);
        }
      } catch (e) {
        errs.push(`${lang}: ${String(e.message || e)}`);
      }
    }
    if (errs.length) {
      const msg = errs.join('; ');
      console.warn(`[bake] ${l.lecture_id}: ${msg}`);
      if (!langsDone.includes('en')) {
        report.push({ idx: l.idx, lectureId: l.lecture_id, title: l.title, error: msg });
        continue;
      }
      // English baked but some language incomplete — record it AND report
      // it as a failure: a classroom may only start when EVERY supported
      // language is fully baked, so partial coverage must block 'ready'.
      await getPool().query(
        `UPDATE course_lectures SET artifacts = artifacts || $2 WHERE lecture_id=$1`,
        [l.lecture_id, JSON.stringify({ baked_langs: langsDone, partial_langs: errs })]);
      report.push({ idx: l.idx, lectureId: l.lecture_id, title: l.title,
        error: `incomplete language coverage: ${msg}` });
    } else {
      await getPool().query(
        `UPDATE course_lectures SET artifacts = artifacts || $2 WHERE lecture_id=$1`,
        [l.lecture_id, JSON.stringify({ baked_langs: langsDone })]);
    }
    // Language-independent slide render warm — any lang failure is tolerated.
    if (langsDone.includes('en')) {
      try { await warmLectureSlides(l.lecture_id); } catch (e) {
        console.warn(`[bake] slide warm ${l.lecture_id}:`, e.message.slice(0, 120));
      }
    }
  }
  return report;
}
