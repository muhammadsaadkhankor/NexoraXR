// Language readiness gate for NCIP mid-lecture switching.
// A language is ready only when EVERY segment of the lecture's canonical
// (English) manifest has BOTH its translated text and baked audio in the
// language-keyed cache bucket — a partially prepared language would degrade
// to per-segment lazy translate+TTS mid-lecture — AND every deterministic
// utterance (opening/transitions/closing recap) has pre-baked audio.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLectureManifest, utteranceReadiness } from '../../nexora_ai/routes/lectureRoutes.mjs';
import { LANGUAGE_CODES } from '../../shared/languages.mjs';

const SEGMENTS_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../nexora_ai/lecture_cache/segments');

const pad = (i) => `segment_${String(i).padStart(3, '0')}`;

// Returns { ready, readyCount, total, utterances }. 'en' segments are ready
// when the lecture manifest loads — utterances still require baked files.
export async function isLanguageReady(lectureId, lang) {
  const manifest = await loadLectureManifest(lectureId, 'en');
  const total = manifest.segments.length;
  if (!total) return { ready: false, readyCount: 0, total: 0,
    utterances: { ready: false, expected: 0, have: 0 } };

  let readyCount = total;
  const missingSegments = [];
  if (lang !== 'en') {
    const dir = path.join(SEGMENTS_ROOT, `${lectureId}__${lang}`);
    readyCount = 0;
    for (let i = 0; i < total; i++) {
      if (existsSync(path.join(dir, `${pad(i)}.txt`)) &&
          existsSync(path.join(dir, `${pad(i)}.wav`))) {
        readyCount++;
      } else missingSegments.push(i);
    }
  }
  let utterances = { ready: false, expected: 0, have: 0 };
  try { utterances = await utteranceReadiness(lectureId, lang); }
  catch { /* unreadable plan/manifest — treated as not ready */ }
  return {
    ready: readyCount === total && utterances.ready,
    readyCount, total, utterances, missingSegments,
  };
}

// Full readiness matrix for every supported language — used by the
// lecture-start gate and the classroom's language menu.
// Returns { langs: {en:{ready,...}, ...}, allReady, missing: [reasons] }.
export async function lectureReadiness(lectureId) {
  const langs = {};
  const missing = [];
  for (const lang of LANGUAGE_CODES) {
    try {
      langs[lang] = await isLanguageReady(lectureId, lang);
    } catch {
      langs[lang] = { ready: false, readyCount: 0, total: 0,
        utterances: { ready: false, expected: 0, have: 0 } };
    }
    const r = langs[lang];
    if (!r.ready) {
      const bits = [];
      if (r.readyCount < r.total) {
        bits.push(`${r.readyCount}/${r.total} segments` +
          (r.missingSegments?.length ? ` (failed: ${r.missingSegments.join(', ')})` : ''));
      }
      if (!r.utterances.ready && r.utterances.expected) {
        bits.push(`${r.utterances.have}/${r.utterances.expected} utterances` +
          (r.utterances.missing?.length
            ? ` (missing: ${r.utterances.missing.map((u) => u.purpose).join(', ')})` : ''));
      }
      missing.push(`${lang.toUpperCase()}: ${bits.join(', ') || 'not checked'}`);
    }
  }
  return {
    langs,
    allReady: Object.values(langs).every((r) => r.ready),
    missing,
  };
}
