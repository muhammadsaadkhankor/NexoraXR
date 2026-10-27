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
// estimated. Spec band is 5–10 min; the floor has slack for short primers.
// A lecture outside it fails the build.
const AUDIO_MIN_S = Number(process.env.COURSE_AUDIO_MIN_S || 240);
const AUDIO_MAX_S = Number(process.env.COURSE_AUDIO_MAX_S || 600);

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

// Bake one lecture: manifest → per-segment audio + lipsync marker + duration.
// Returns {segments, durationMs, durationMin} or throws on unbakeable lecture.
export async function bakeLecture(lectureId, lang = 'en') {
  const manifest = await loadLectureManifest(lectureId, lang);
  const segments = manifest.segments || [];
  if (!segments.length) throw new Error(`No segments for ${lectureId}`);

  let totalMs = 0;
  const missing = [];
  // Bounded concurrency — local TTS shouldn't be hammered.
  for (let i = 0; i < segments.length; i += CONCURRENCY) {
    const batch = segments.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async (seg, j) => {
      const idx = seg.id ?? i + j;
      try {
        const p = audioPath(lectureId, idx, lang);
        // generateSegmentAudio derives dir + lang FROM the id — pass the
        // lang-keyed cacheKey (gen_L1__ar), not the base lectureId, or
        // non-English audio lands in the English cache (and clobbers it).
        if (!existsSync(p)) await generateSegmentAudio(cacheKey(lectureId, lang), idx, seg.text, lang);
        const wav = await fsp.readFile(p);
        totalMs += wavDurationMs(wav);
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
  return { segments: segments.length, durationMs: totalMs, durationMin: totalMs / 60000 };
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
  let topics = null;
  try {
    const plan = JSON.parse(await fsp.readFile(path.join(PROFBRAIN_DIR, lectureId, 'lecture_plan.json'), 'utf-8'));
    topics = plan?.topics || null;
  } catch { /* legacy lectures have no plan */ }
  const manifest = await loadLectureManifest(lectureId, lang);
  const segIds = manifest.segments.map((s) => s.id);
  const calls = [];
  const first = topics?.[0];
  calls.push({ purpose: 'opening', topicId: first?.id ?? null, sourceSegmentIds: [segIds[0]] });
  for (const t of (topics || []).slice(1)) {
    calls.push({ purpose: 'transition', topicId: t.id, sourceSegmentIds: t.segmentIds.filter((id) => segIds.includes(id)) });
  }
  const last = topics?.[topics.length - 1];
  calls.push({ purpose: 'closing_recap', topicId: last?.id ?? null, sourceSegmentIds: segIds });
  for (const c of calls) {
    try {
      await generateLectureUtterance({ lectureId, language: lang, ...c });
    } catch (e) {
      console.warn(`[bake] utterance warm ${lectureId}/${lang}/${c.purpose}:`, e.message.slice(0, 120));
    }
  }
}

// Languages baked ahead of time — instructor selects which; the default is
// only the teaching language (fast path). Legacy callers with no selection
// fall back to COURSE_BAKE_LANGS (env, default all) so older flows work.
const BAKE_LANGS = (process.env.COURSE_BAKE_LANGS || 'en,ar,fr,de,es,zh')
  .split(',').map((s) => s.trim()).filter(Boolean);

// Verify a whole course: every lecture has complete audio in the selected
// languages. Per-language timings are recorded in the returned report.
export async function verifyCourseAudio(courseId, langs = null) {
  const langList = Array.isArray(langs) && langs.length ? langs : BAKE_LANGS;
  if (!(await ttsReachable())) {
    throw new Error(`TTS service unreachable at ${process.env.VOXCPM_BASE_URL || 'http://localhost:8010'} — start VoxCPM2 and rebuild`);
  }
  const { rows } = await getPool().query(
    `SELECT idx, lecture_id, title FROM course_lectures
      WHERE course_id=$1 AND COALESCE(artifacts->'script','0'::jsonb)::text = '1' ORDER BY idx`, [courseId]);
  const report = [];
  const timings = {};
  for (const l of rows) {
    const langsDone = [], errs = [];
    for (const lang of langList) {
      const t0 = Date.now();
      try {
        const r = await bakeLecture(l.lecture_id, lang);
        await warmLectureUtterances(l.lecture_id, lang);
        langsDone.push(lang);
        timings[`${l.lecture_id}@${lang}`] = Date.now() - t0;
        if (lang === 'en') {
          const onTarget = r.durationMs >= AUDIO_MIN_S * 1000 && r.durationMs <= AUDIO_MAX_S * 1000;
          const entry = { idx: l.idx, lectureId: l.lecture_id, title: l.title, ...r, onTarget, timings };
          // Out-of-band audio is a build-level failure — blocks publication.
          if (!onTarget) {
            entry.error = `duration ${r.durationMin.toFixed(1)}m outside ` +
              `${(AUDIO_MIN_S / 60).toFixed(1)}–${(AUDIO_MAX_S / 60).toFixed(1)}m band`;
          }
          report.push(entry);
          await getPool().query(
            `UPDATE course_lectures SET artifacts = artifacts || $2 WHERE lecture_id=$1`,
            [l.lecture_id, JSON.stringify({
              audio: 1, duration_s: Math.round(r.durationMs / 1000), segments: r.segments,
              ...(onTarget ? {} : { validation: { ok: false, problems: [entry.error] } }),
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
      // English baked — partial language coverage is non-fatal, note it.
      await getPool().query(
        `UPDATE course_lectures SET artifacts = artifacts || $2 WHERE lecture_id=$1`,
        [l.lecture_id, JSON.stringify({ baked_langs: langsDone, partial_langs: errs })]);
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
