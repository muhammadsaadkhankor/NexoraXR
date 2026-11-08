// Bake audio for the manually-authored Multimedia lectures (multimedia_L1/L2):
// every segment × 6 languages + the deterministic utterances (opening /
// closing_recap — no lecture_plan.json → only those two are planned).
// Reuses the same code paths as the runtime lazy-TTS and course bake so the
// produced files are byte-identical cache entries.
//
// Usage:
//   node scripts/bake_multimedia.mjs [--segments-only] [--utterances-only]
//     [--lecture multimedia_L1] [--lang ar] [--conc 3]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// Standalone runs don't inherit the backend's dotenv — load the same .env so
// OLLAMA_MODEL/TTS_URL/etc. match what the server uses.
for (const line of fs.readFileSync(path.join(ROOT, 'src/nexora_server/.env'), 'utf-8').split('\n')) {
  const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
}
const PROFBRAIN = path.join(ROOT, 'profbrain', 'lectures');
const CACHE_SEG = path.join(ROOT, 'src', 'nexora_ai', 'lecture_cache', 'segments');

const {
  generateSegmentAudio,
  generateLectureUtterance,
  plannedUtteranceCalls,
  loadLectureManifest,
  utteranceReadiness,
  utteranceCacheKey,
  UTTERANCE_FALLBACK_TEXT,
} = await import(path.join(ROOT, 'src/nexora_ai/routes/lectureRoutes.mjs'));
const { synthesizeVerified, getDefaultVoice } =
  await import(path.join(ROOT, 'src/nexora_ai/modules/ttsClient.mjs'));

const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : d;
};
const SEG_ONLY = args.includes('--segments-only');
const UTT_ONLY = args.includes('--utterances-only');
const LECTURES = opt('lecture', null)
  ? opt('lecture').split(',')
  : Array.from({ length: 8 }, (_, i) => `multimedia_L${i + 1}`);
const LANGS = opt('lang', null) ? [opt('lang')] : ['en', 'ar', 'de', 'es', 'fr', 'zh'];
const CONC = Number(opt('conc', '3')) || 3;

const pad = (i) => `segment_${String(i).padStart(3, '0')}`;

function segText(lectureId, lang, idx) {
  const dir = lang === 'en' ? lectureId : `${lectureId}__${lang}`;
  return fs.readFileSync(path.join(CACHE_SEG, dir, `${pad(idx)}.txt`), 'utf-8');
}
function segDone(lectureId, lang, idx) {
  const dir = lang === 'en' ? lectureId : `${lectureId}__${lang}`;
  return fs.existsSync(path.join(CACHE_SEG, dir, `${pad(idx)}.wav`));
}

async function bakeSegments(lectureId, lang) {
  const n = JSON.parse(fs.readFileSync(path.join(PROFBRAIN, lectureId, 'segments.json'), 'utf-8')).segments.length;
  const cacheKey = lang === 'en' ? lectureId : `${lectureId}__${lang}`;
  let done = 0, failed = 0;
  for (let i = 0; i < n; i++) {
    if (segDone(lectureId, lang, i)) { done++; continue; }
    try {
      await generateSegmentAudio(cacheKey, i, segText(lectureId, lang, i));
      done++;
      console.log(`[bake] ${cacheKey}/${i} ok (${done}/${n})`);
    } catch (e) {
      failed++;
      console.error(`[bake] ${cacheKey}/${i} FAIL: ${e.message?.slice(0, 160)}`);
    }
  }
  return { done, failed, total: n };
}

// Deterministic utterances — same cache key contract as the runtime path,
// but text comes from UTTERANCE_FALLBACK_TEXT (pre-translated, language-safe)
// instead of the LLM. Writes utt_<key>.txt + .wav; readiness passes and the
// runtime reuses the cached text verbatim (no text/audio mismatch).
const ANSWERS_DIR = path.join(ROOT, 'src', 'nexora_ai', 'lecture_cache', 'answers');
const cleanTextForTts = (t) => t
  .replace(/\*\*/g, '').replace(/\[[^\]]*\]/g, '').replace(/\{[^}]*\}/g, '')
  .replace(/^\s*[-*•–]\s+/gm, '').replace(/^\s*\d+\.\s+/gm, '')
  .replace(/\s+/g, ' ').trim();

async function bakeUtterancesDeterministic(lectureId, lang) {
  const manifest = await loadLectureManifest(lectureId, lang);
  const calls = await plannedUtteranceCalls(lectureId, manifest);
  const voiceId = await getDefaultVoice();
  fs.mkdirSync(ANSWERS_DIR, { recursive: true });
  let ok = 0, fail = 0;
  for (const c of calls) {
    try {
      const texts = c.sourceSegmentIds
        .map((sid) => manifest.segments.find((s) => s.id === sid)?.text || '');
      const material = texts.join('\n\n');
      // instruction must match utteranceReadiness' key computation exactly.
      const INSTRUCTIONS = {
        opening: "Greet the class warmly and say you're starting today's lecture. Do NOT preview, explain, or summarize any topic — the prepared material that follows does that itself. At most 2 short spoken sentences, then hand off naturally.",
        transition: 'Say exactly ONE short connector sentence that moves naturally from the previous topic to the next one. Do NOT summarize the previous topic. Do NOT explain or preview the next topic — just connect them.',
        closing_recap: 'Wrap up the lecture: summarize what was covered and name the most important concepts. Do not introduce new material. 3-4 short spoken sentences.',
      };
      const key = utteranceCacheKey({
        lectureId, lang, purpose: c.purpose, topicId: c.topicId ?? '',
        sourceSegmentIds: c.sourceSegmentIds,
        instruction: INSTRUCTIONS[c.purpose], material,
      });
      const audioPath = path.join(ANSWERS_DIR, `utt_${key}.wav`);
      const textPath = path.join(ANSWERS_DIR, `utt_${key}.txt`);
      // Match the runtime's deterministic EN welcome (course-name included);
      // other purposes/languages use the pre-translated fallback templates.
      const text = (c.purpose === 'opening' && lang === 'en')
        ? `Welcome to ${manifest.course || manifest.title}. Let's get started with today's lecture.`
        : (UTTERANCE_FALLBACK_TEXT[c.purpose]?.[lang]
           || UTTERANCE_FALLBACK_TEXT.transition[lang]);
      if (!fs.existsSync(textPath)) fs.writeFileSync(textPath, text);
      if (!fs.existsSync(audioPath)) {
        const buf = await synthesizeVerified(cleanTextForTts(text), voiceId, lang,
          { lectureId, segmentId: `utt_${c.purpose}` });
        fs.writeFileSync(audioPath, buf);
      }
      ok++;
      console.log(`[utt] ${lectureId}/${lang} ${c.purpose} ok (fallback-text)`);
    } catch (e) {
      fail++;
      console.error(`[utt] ${lectureId}/${lang} ${c.purpose} FAIL: ${e.message?.slice(0, 160)}`);
    }
  }
  return { ok, fail, expected: calls.length };
}

async function bakeUtterances(lectureId, lang) {
  if (args.includes('--deterministic-utts')) return bakeUtterancesDeterministic(lectureId, lang);
  const manifest = await loadLectureManifest(lectureId, lang);
  const calls = await plannedUtteranceCalls(lectureId, manifest);
  let ok = 0, fail = 0;
  for (const c of calls) {
    try {
      const r = await generateLectureUtterance({
        lectureId, language: lang, purpose: c.purpose,
        topicId: c.topicId ?? '', sourceSegmentIds: c.sourceSegmentIds,
      });
      ok++;
      console.log(`[utt] ${lectureId}/${lang} ${c.purpose} ok (${r.audioUrl ? 'wav' : '?'})`);
    } catch (e) {
      fail++;
      console.error(`[utt] ${lectureId}/${lang} ${c.purpose} FAIL: ${e.message?.slice(0, 160)}`);
    }
  }
  return { ok, fail, expected: calls.length };
}

// Small worker pool over (lecture, lang) jobs.
const jobs = [];
for (const L of LECTURES) for (const lang of LANGS) jobs.push({ L, lang });

const t0 = Date.now();
const results = [];
let cursor = 0;
async function worker(id) {
  while (cursor < jobs.length) {
    const j = jobs[cursor++];
    if (!UTT_ONLY) {
      const r = await bakeSegments(j.L, j.lang);
      results.push(`segments ${j.L}__${j.lang}: ${r.done}/${r.total} ok, ${r.failed} failed`);
    }
    if (!SEG_ONLY) {
      const r = await bakeUtterances(j.L, j.lang);
      results.push(`utterances ${j.L}__${j.lang}: ${r.ok}/${r.expected} ok, ${r.fail} failed`);
    }
  }
}
await Promise.all(Array.from({ length: CONC }, (_, i) => worker(i)));

console.log('\n==== BAKE SUMMARY ====');
for (const r of results) console.log(' ', r);
console.log(`elapsed: ${((Date.now() - t0) / 60000).toFixed(1)} min`);
