// Language readiness gate for NCIP mid-lecture switching.
// A language is ready only when EVERY segment of the lecture's canonical
// (English) manifest has BOTH its translated text and baked audio in the
// language-keyed cache bucket — a partially prepared language would degrade
// to per-segment lazy translate+TTS mid-lecture.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLectureManifest } from '../../nexora_ai/routes/lectureRoutes.mjs';

const SEGMENTS_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../nexora_ai/lecture_cache/segments');

const pad = (i) => `segment_${String(i).padStart(3, '0')}`;

// Returns { ready, readyCount, total }. 'en' is always ready when the
// lecture manifest loads — the canonical script drives everything.
export async function isLanguageReady(lectureId, lang) {
  const manifest = await loadLectureManifest(lectureId, 'en');
  const total = manifest.segments.length;
  if (!total) return { ready: false, readyCount: 0, total: 0 };
  if (lang === 'en') return { ready: true, readyCount: total, total };

  const dir = path.join(SEGMENTS_ROOT, `${lectureId}__${lang}`);
  let readyCount = 0;
  for (let i = 0; i < total; i++) {
    if (existsSync(path.join(dir, `${pad(i)}.txt`)) &&
        existsSync(path.join(dir, `${pad(i)}.wav`))) {
      readyCount++;
    }
  }
  return { ready: readyCount === total, readyCount, total };
}
