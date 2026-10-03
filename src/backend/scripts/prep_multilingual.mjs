#!/usr/bin/env node
// Pre-bakes every lecture × language into the segment cache so live
// language switching is instant (the same job the bionic professor
// does with pre-authored topic packages).
//
// Requires: backend (:3000) + vLLM-Omni (:8010) + Ollama (:11434) running.
// Usage:  node scripts/prep_multilingual.mjs            (all langs)
//         PREP_LANGS=ar node scripts/prep_multilingual.mjs

const API = process.env.API_URL || 'http://localhost:3000';
const LANGS = (process.env.PREP_LANGS || 'ar,fr,de,es').split(',').map((s) => s.trim());
const LECTURES = Array.from({ length: 8 }, (_, i) => `Lecture_${i + 1}`);

for (const lectureId of LECTURES) {
  for (const lang of LANGS) {
    const t0 = Date.now();
    try {
      const res = await fetch(`${API}/api/lecture/segments/${lectureId}?lang=${lang}`);
      const data = await res.json();
      if (!res.ok) {
        console.error(`✗ ${lectureId}/${lang}: ${data.error || res.status}`);
        continue;
      }
      console.log(`✓ ${lectureId}/${lang}: ${data.segments.length} segments (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
    } catch (err) {
      console.error(`✗ ${lectureId}/${lang}: ${err.message}`);
    }
  }
}
console.log('Done.');
