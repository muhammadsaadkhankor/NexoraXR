// Phase 6 — durable, resumable course builds.
//
//   pending → ingesting → planning → scripts → awaiting_review
//           → audio → validating → ready | failed
//
// The 'awaiting_review' gate pauses the build for human script review —
// audio bakes only after explicit approval (runAudioPhase).
//
// State lives in course_builds + per-lecture artifacts in course_lectures, so
// a restart mid-build picks up where it stopped: ingestion skips 'ready' docs,
// emit upserts lectures, audio bake skips existing segment files.

import crypto from 'node:crypto';
import { getPool } from '../db/pool.mjs';
import { ingestDocument } from './pipeline.mjs';
import { generateLecture as generateLectureV1, emitLecture, planFromDocuments } from './generator.mjs';
import { generateLectureV2, recordEval } from './generator2.mjs';
import { generateLectureV3, recordEvalV3 } from './generator3.mjs';
import { generateLectureFast } from './generator4.mjs';

// Versioned generator switch — COURSE_GENERATOR=v1|v2|v3 (default v3).
// v1 = single-shot baseline; v2 = heuristic inventory + topic budget;
// v3 = semantic concept map → dependency-ordered plan → batched writing.
// 'fast' is the default production path (≤2 LLM calls/lecture). v1/v2/v3 stay
// selectable for research comparison via COURSE_GENERATOR.
const GEN_VERSION = (process.env.COURSE_GENERATOR || 'fast').toLowerCase();
const generateLecture = {
  v1: generateLectureV1, v2: generateLectureV2, v3: generateLectureV3,
  fast: generateLectureFast,
}[GEN_VERSION] || generateLectureFast;
const recordEvalFor = {
  v3: (cid, e, l) => recordEvalV3(cid, e, l, { genMeta: l.genMeta }),
  fast: (cid, e, l) => recordEvalV3(cid, e, l, { genMeta: l.genMeta, generatorVersion: l.genMeta?.generator || 'fast.1' }),
  v2: (cid, e, l) => recordEval(cid, e, l, { genMeta: l.genMeta }),
}[GEN_VERSION];
import { prepareTranslations, textFingerprintForBake } from './drafts.mjs';
import { verifyCourseAudio } from './bake.mjs';
import { llmConfigured } from './llm.mjs';

const running = new Map(); // courseId -> buildId (in-memory guard only)

async function setStep(buildId, status, patch = {}) {
  await getPool().query(
    `UPDATE course_builds SET status=$2, error=$3, stats=COALESCE(stats,'{}'::jsonb) || $4::jsonb, updated_at=now()
      WHERE id=$1`,
    [buildId, status, patch.error || null, JSON.stringify(patch)]);
}

export async function startBuild(courseId, lectureCount, lang = 'en', lecturePlan = null) {
  const pool = getPool();
  const buildId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO course_builds (id, course_id, status, lecture_count, lang) VALUES ($1,$2,'ingesting',$3,$4)`,
    [buildId, courseId, lectureCount, lang]);
  // Reviewer-confirmed lecture list (one PDF = one lecture) rides on the
  // build — deterministic plan replaces the LLM planner for this flow.
  if (lecturePlan) {
    await pool.query(
      `INSERT INTO course_plans (course_id, outline, lecture_count, status, updated_at)
         VALUES ($1,$2,$3,'draft',now())
       ON CONFLICT (course_id) DO UPDATE SET outline=$2, lecture_count=$3, updated_at=now()`,
      [courseId, JSON.stringify(lecturePlan), lecturePlan.length]);
  }
  return buildId;
}

// Deterministic outline when no reviewer-supplied plan exists — mirrors the
// two supported allocations; never calls the LLM allocator.
async function deriveOutline(courseId, lectureCount) {
  const pool = getPool();
  const { rows: docs } = await pool.query(
    `SELECT id AS "documentId", filename, pages, summary, title FROM course_documents
      WHERE course_id=$1 AND status='ready' ORDER BY created_at`, [courseId]);
  if (!docs.length) return [];
  const { lectures } = planFromDocuments(docs);
  if (lectures.length === lectureCount) return lectures;
  // Counts differ → fullCoverage: every document scoped to every lecture.
  const sources = docs.map((d) => ({ filename: d.filename, documentId: d.documentId, pages: [[1, d.pages || 999]] }));
  return Array.from({ length: lectureCount }, (_, i) => ({
    idx: i + 1, title: `Lecture ${i + 1}`, objectives: [], queries: [],
    fullCoverage: true, sources,
  }));
}

export async function runBuild(buildId, courseId, lectureCount, lang = 'en', lecturePlan = null) {
  if (!llmConfigured()) {
    await setStep(buildId, 'failed', { error: 'No LLM configured (OPENAI_API_KEY or OLLAMA_BASE_URL)' });
    return;
  }
  running.set(courseId, buildId);
  const pool = getPool();
  try {
    // --- ingesting ---
    await setStep(buildId, 'ingesting');
    // Uploads register docs asynchronously — wait briefly for rows to appear
    // before deciding the course is empty (avoids the build/upload race).
    let pending = [];
    for (let attempt = 0; attempt < 60; attempt++) {
      const { rows } = await pool.query(
        `SELECT id, status FROM course_documents WHERE course_id=$1`, [courseId]);
      pending = rows.filter((r) => r.status !== 'ready');
      if (pending.length) break;                    // wait for these to finish below
      if (rows.length) break;                       // all ready — proceed
      if (attempt === 59 && !rows.length) break;    // truly no docs uploaded
      await new Promise((r) => setTimeout(r, 1000));
    }
    // Pending docs are already being ingested by the upload handler — don't
    // run ingestDocument twice on the same doc. Only retry explicit failures.
    for (const d of pending.filter((x) => x.status === 'failed')) {
      try { await ingestDocument(d.id); } catch { /* stays failed */ }
    }
    // Wait for in-flight ingestions to land — 'pending' AND 'processing'
    // both mean "not done yet".
    for (let attempt = 0; attempt < 120; attempt++) {
      const { rows: [{ n }] } = await pool.query(
        `SELECT count(*) AS n FROM course_documents WHERE course_id=$1 AND status IN ('pending','processing')`, [courseId]);
      if (+n === 0) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    const { rows: [stuck] } = await pool.query(
      `SELECT count(*) AS bad FROM course_documents WHERE course_id=$1 AND status='failed'`, [courseId]);
    if (+stuck.bad) {
      await setStep(buildId, 'failed', { error: `${stuck.bad} document(s) failed extraction` });
      return;
    }

    // --- planning — a reviewer-confirmed lecturePlan (1 PDF = 1 lecture)
    // skips allocation entirely. Without one, derive deterministically:
    //   PDFs == lectureCount → one-PDF-per-lecture (planFromDocuments).
    //   Otherwise           → existing fullCoverage allocation (every doc
    //                         scoped to every lecture; no LLM call).
    await setStep(buildId, 'planning');
    const outline = lecturePlan || await deriveOutline(courseId, lectureCount);
    if (outline.length !== lectureCount) {
      await setStep(buildId, 'failed', {
        error: `Planner produced ${outline.length} lectures, expected ${lectureCount}` });
      return;
    }

    // --- scripts + slides (emitLecture writes both per lecture) ---
    await setStep(buildId, 'scripts');
    for (const entry of outline) {
      // Resume-safe: skip lectures already fully produced for THIS build.
      const { rows: [have] } = await pool.query(
        `SELECT artifacts FROM course_lectures WHERE course_id=$1 AND idx=$2 AND build_id=$3`,
        [courseId, entry.idx, buildId]);
      if (have?.artifacts?.script && have?.artifacts?.slides) continue;
      try {
        const lecture = await generateLecture(courseId, entry);
        await emitLecture(courseId, entry, lecture, { buildId });
        if (lecture.validation?.ok === false) {
          console.warn(`[course] lecture ${entry.idx} failed validation: ${lecture.validation.problems.join('; ')}`);
        } else if (lecture.validation?.warnings?.length) {
          console.warn(`[course] lecture ${entry.idx} provenance warnings: ${lecture.validation.warnings.join('; ')}`);
        }
        if (recordEvalFor) await recordEvalFor(courseId, entry, lecture).catch(() => {});
      } catch (err) {
        // One bad lecture must not kill the build — record the failure so the
        // lecture stays unpublished and the build can finish the rest.
        console.error(`[course] lecture ${entry.idx} generation failed:`, err.message);
        await pool.query(
          `INSERT INTO course_lectures (id, course_id, idx, lecture_id, title, status, manifest, build_id, artifacts)
           VALUES ($1,$2,$3,$4,$5,'draft',$6,$7,$8)
           ON CONFLICT (course_id, idx) DO UPDATE SET build_id=$7, artifacts=$8, created_at=now()`,
          [crypto.randomUUID(), courseId, entry.idx,
           `gen_${courseId.slice(0, 8)}_L${entry.idx}`, entry.title,
           JSON.stringify({ title: entry.title, topics: [] }), buildId,
           JSON.stringify({ script: 0, slides: 0, validation: { ok: false, problems: [err.message] } })]);
      }
      await setStep(buildId, 'scripts', { progress: `${entry.idx}/${outline.length}` });
    }

    // --- script review gate — build STOPS here. Drafts sit in
    // profbrain/lectures/<lid>/segments.json until an authorised reviewer
    // approves; audio is NOT generated automatically. The approve endpoint
    // kicks the translation stage, then a second review gate per language,
    // then runAudioPhase for the exact reviewed text.
    await setStep(buildId, 'awaiting_review', { lectures: outline.length, stage: 'scripts' });
    console.log(`[course] build ${buildId} awaiting review: ${lectureCount} lecture drafts`);
  } catch (err) {
    await setStep(buildId, 'failed', { error: String(err.message || err).slice(0, 400) });
    console.error(`[course] build ${buildId} failed:`, err.message);
  } finally {
    running.delete(courseId);
  }
}

// Stage 2a — translate the APPROVED canonical script into every supported
// language, then park at a second review gate (stage 'translations') so the
// reviewer can edit each language before audio.
export async function runTranslationPhase(buildId, courseId) {
  running.set(courseId, buildId);
  const t0 = Date.now();
  try {
    await setStep(buildId, 'translating');
    const report = await prepareTranslations(courseId);
    const failed = report.filter((r) => r.status === 'failed');
    await setStep(buildId, 'awaiting_review', {
      stage: 'translations',
      stage_timings: { translating_ms: Date.now() - t0 },
      translations: report,
      ...(failed.length ? { translation_errors: failed.map((f) => `${f.lectureId}/${f.lang}: ${f.error}`) } : {}),
    });
    console.log(`[course] build ${buildId} translations ready for review (${report.length} lang-drafts)`);
  } catch (err) {
    await setStep(buildId, 'failed', { error: String(err.message || err).slice(0, 400) });
  } finally {
    running.delete(courseId);
  }
}

// Stage 2b — audio + lipsync bake for the APPROVED script text. Started by
// the approve endpoint (after an atomic awaiting_review -> audio transition)
// or by resumeInterrupted for a build that died mid-bake. Before baking we
// verify the on-disk text still matches what was approved — edits racing a
// bake can't publish a mismatched script/audio pair.
export async function runAudioPhase(buildId, courseId, lectureCount) {
  const pool = getPool();
  running.set(courseId, buildId);
  try {
    // Approved fingerprints + instructor-selected audio languages.
    const { rows: [b] } = await pool.query(
      `SELECT stats, lang FROM course_builds WHERE id=$1`, [buildId]);
    const audioLangs = Array.isArray(b?.stats?.audio_langs) && b.stats.audio_langs.length
      ? b.stats.audio_langs : [b?.lang || 'en'];
    const approved = b?.stats?.approved || {};
    for (const [key, fp] of Object.entries(approved)) {
      const sep = key.lastIndexOf('@');
      const [lid, lang] = [key.slice(0, sep), key.slice(sep + 1)];
      const now = await textFingerprintForBake(lid, lang);
      if (now !== fp) {
        await setStep(buildId, 'awaiting_review', {
          stage: 'translations',
          error: `${lid}/${lang}: script changed after approval — review again before audio`,
        });
        return;
      }
    }
    const audioT0 = Date.now();
    await setStep(buildId, 'audio');
    const audioReport = await verifyCourseAudio(courseId, audioLangs);
    const failedAudio = audioReport.filter((r) => r.error);
    if (failedAudio.length) {
      await setStep(buildId, 'failed', {
        error: `audio bake failed on ${failedAudio.length} lecture(s): ${failedAudio[0].error}` });
      return;
    }

    // --- validating ---
    await setStep(buildId, 'validating');
    const { rows: [missing] } = await pool.query(
      `SELECT count(*) AS n FROM course_lectures WHERE course_id=$1 AND status IN ('draft','ready')`, [courseId]);
    if (+missing.n !== lectureCount) {
      await setStep(buildId, 'failed', { error: `Expected ${lectureCount} lectures, have ${missing.n}` });
      return;
    }

    await setStep(buildId, 'ready', {
      lectures: audioReport,
      stage_timings: { audio_ms: Date.now() - audioT0,
        per_lang: audioReport[0]?.timings || {} },
    });
    console.log(`[course] build ${buildId} ready: ${lectureCount} lectures, audio baked in ${((Date.now() - audioT0) / 60000).toFixed(1)}m`);
  } catch (err) {
    await setStep(buildId, 'failed', { error: String(err.message || err).slice(0, 400) });
    console.error(`[course] build ${buildId} failed:`, err.message);
  } finally {
    running.delete(courseId);
  }
}

export function buildRunning(courseId) { return running.has(courseId); }

// Resume crashed/interrupted builds on server boot. 'awaiting_review' is a
// parked state — it waits for a human, not a retry. Builds that died inside
// the audio stage resume from there directly.
export async function resumeInterrupted() {
  try {
    const { rows } = await getPool().query(
      `SELECT id, course_id, lecture_count, lang, status FROM course_builds
        WHERE status NOT IN ('ready','failed','awaiting_review') ORDER BY created_at`);
    for (const b of rows) {
      const audioStage = b.status === 'audio' || b.status === 'validating';
      const transStage = b.status === 'translating';
      console.log(`[course] resuming interrupted build ${b.id} for ${b.course_id} (${audioStage ? 'audio' : transStage ? 'translations' : 'scripts'} stage)`);
      setImmediate(() => audioStage
        ? runAudioPhase(b.id, b.course_id, b.lecture_count)
        : transStage
          ? runTranslationPhase(b.id, b.course_id)
          : runBuild(b.id, b.course_id, b.lecture_count, b.lang));
    }
  } catch (e) { console.error('[course] resume scan failed:', e.message); }
}

export async function buildStatus(courseId) {
  const pool = getPool();
  const { rows: [build] } = await pool.query(
    `SELECT * FROM course_builds WHERE course_id=$1 ORDER BY created_at DESC LIMIT 1`, [courseId]);
  const { rows: docs } = await pool.query(
    `SELECT id, filename, status, error, pages FROM course_documents WHERE course_id=$1 ORDER BY created_at`, [courseId]);
  const { rows: [plan] } = await pool.query(
    `SELECT outline, lecture_count FROM course_plans WHERE course_id=$1`, [courseId]);
  const { rows: lectures } = await pool.query(
    `SELECT idx, lecture_id, title, status, artifacts FROM course_lectures WHERE course_id=$1 ORDER BY idx`, [courseId]);
  return {
    build: build ? { id: build.id, status: build.status, error: build.error, stats: build.stats } : { status: 'idle' },
    llm: llmConfigured(),
    documents: docs,
    outline: plan?.outline || null,
    lectures: lectures.map((l) => ({ ...l, lectureId: l.lecture_id })),
  };
}
