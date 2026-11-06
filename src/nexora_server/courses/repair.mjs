// Lecture/course repair — completes missing multilingual work for an
// already-written course: missing translated segment text, missing baked
// segment audio, and missing pre-baked utterances. Everything is
// incremental: existing files/drafts are reused, only holes are redone.
//
// Runs automatically on server boot for every course that is not allReady,
// and on demand via POST /api/lecture/:lectureId/repair or
// POST /api/courses/:courseId/repair (instructor only).

import { getPool } from '../db/pool.mjs';
import { isLanguageReady, lectureReadiness } from '../protocol/languageReady.mjs';
import { bakeLecture, warmLectureUtterances } from './bake.mjs';
import { prepareTranslations } from './drafts.mjs';
import { LANGUAGE_CODES } from '../../shared/languages.mjs';

const running = new Map(); // courseId|lectureId -> {startedAt, progress}
export const repairStatus = (key) => running.get(key) || null;
export const anyRepairRunning = () => running.size > 0;

async function repairLectureInner(lectureId, onProgress) {
  const errs = [];
  for (const lang of LANGUAGE_CODES) {
    const r0 = await isLanguageReady(lectureId, lang).catch(() => null);
    if (r0?.ready) continue;
    onProgress?.(`${lectureId}/${lang} segments ${r0?.readyCount ?? 0}/${r0?.total ?? '?'}`);
    // Missing TEXT is the translation stage's job — prepareTranslations
    // already fills only invalid/missing draft segments. (Called once per
    // course by repairCourse; a lone-lecture repair calls it via courseId.)
    try { await bakeLecture(lectureId, lang); }
    catch (e) { errs.push(`${lang}: ${String(e.message || e).slice(0, 160)}`); }
    try { await warmLectureUtterances(lectureId, lang); }
    catch (e) { errs.push(`${lang}: utterances: ${String(e.message || e).slice(0, 120)}`); }
    // Second utterance pass — warm uses the same cache keys so a transient
    // TTS/LLM failure retries only the utterances still missing.
    const utt = await isLanguageReady(lectureId, lang).catch(() => null);
    if (utt && !utt.utterances.ready) {
      try { await warmLectureUtterances(lectureId, lang); }
      catch { /* recorded by final readiness */ }
    }
  }
  return errs;
}

// Full repair for every incompletely-baked lecture of one course.
// Returns {ready, langs, errors} per lecture.
export async function repairCourse(courseId, onProgress) {
  if (running.has(courseId)) return { skipped: 'already running' };
  running.set(courseId, { startedAt: Date.now(), progress: 'starting' });
  const tick = (p) => { running.get(courseId).progress = p; onProgress?.(p); };
  try {
    tick('translating missing segments');
    // Fixes all missing/stale/failed translation drafts for every lecture
    // in the course — invalid drafts are re-translated, valid ones kept.
    const tErrs = [];
    const tReport = await prepareTranslations(courseId).catch((e) => {
      tErrs.push(`translations: ${e.message}`); return [];
    });
    const { rows: lectures } = await getPool().query(
      `SELECT lecture_id FROM course_lectures WHERE course_id=$1
         AND COALESCE(artifacts->'script','0'::jsonb)::text='1' ORDER BY idx`, [courseId]);
    const results = {};
    for (const { lecture_id: lid } of lectures) {
      tick(`baking ${lid}`);
      const errs = [...tErrs, ...(await repairLectureInner(lid, tick))];
      const r = await lectureReadiness(lid);
      const failedSegs = [];
      for (const [lang, lr] of Object.entries(r.langs)) {
        if (!lr.ready && lr.missingSegments?.length) {
          failedSegs.push(...lr.missingSegments.map((idx) => ({ lang, idx, reason: 'missing after repair' })));
        }
      }
      await getPool().query(
        `UPDATE course_lectures SET artifacts = artifacts || $2 WHERE lecture_id=$1`,
        [lid, JSON.stringify({
          baked_langs: Object.entries(r.langs).filter(([, v]) => v.ready).map(([k]) => k),
          partial_langs: errs, failed_segments: failedSegs })]);
      results[lid] = { ready: r.allReady, missing: r.missing, errors: errs };
      tick(`${lid} ${r.allReady ? 'ready' : 'incomplete'}`);
    }
    return { translations: tReport, lectures: results };
  } finally {
    running.delete(courseId);
  }
}

// Repair one lecture (used by the host-facing Retry button).
export async function repairLecture(lectureId, onProgress) {
  if (running.has(lectureId)) return { skipped: 'already running' };
  running.set(lectureId, { startedAt: Date.now(), progress: 'starting' });
  try {
    // The lecture's course gives prepareTranslations its scope.
    const { rows: [row] } = await getPool().query(
      `SELECT course_id FROM course_lectures WHERE lecture_id=$1`, [lectureId]);
    if (row?.course_id) {
      // prepareTranslations is course-scoped; for a lone lecture just run it
      // on the course — it skips everything already valid.
      await prepareTranslations(row.course_id).catch(() => {});
    }
    const errs = await repairLectureInner(lectureId,
      (p) => { running.get(lectureId).progress = p; onProgress?.(p); });
    const r = await lectureReadiness(lectureId);
    return { ready: r.allReady, missing: r.missing, errors: errs };
  } finally {
    running.delete(lectureId);
  }
}

// Boot-time backfill: every lecture that is not allReady queues for repair
// — sequentially, low-pressure. Non-blocking: the caller awaits nothing.
export async function repairIncompleteOnBoot() {
  try {
    const { rows } = await getPool().query(
      `SELECT lecture_id, course_id FROM course_lectures
         WHERE COALESCE(artifacts->'script','0'::jsonb)::text='1'
           AND COALESCE(
             jsonb_array_length(COALESCE(artifacts->'baked_langs','[]'::jsonb)), 0
           ) < $1`, [LANGUAGE_CODES.length]);
    if (!rows.length) return;
    console.log(`[repair] ${rows.length} incompletely-baked lecture(s) found — queueing repair`);
    for (const { lecture_id, course_id } of rows) {
      try {
        const r = await lectureReadiness(lectureId);
        if (r.allReady) continue;
        console.log(`[repair] ${lecture_id}: repairing (${r.missing.join('; ')})`);
        const out = await repairLecture(lectureId,
          (p) => console.log(`[repair] ${lecture_id}: ${p}`));
        console.log(`[repair] ${lecture_id}: ${out.ready ? 'READY' : 'still incomplete: ' + out.missing.join('; ')}`);
      } catch (e) {
        console.warn(`[repair] ${lecture_id} failed:`, String(e.message || e).slice(0, 160));
      }
    }
  } catch (e) {
    console.warn('[repair] boot scan failed:', e.message);
  }
}
