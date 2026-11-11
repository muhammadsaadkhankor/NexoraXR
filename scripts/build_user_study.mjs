// Build the fixed-script "User Study" course (one lecture, six languages)
// from scripts/user_study/<lang>.txt — NO LLM: paragraphs are used verbatim,
// one paragraph = one segment, with an explicit segment→PDF-page map.
// Idempotent: re-running rewrites the lecture files and upserts the DB rows;
// a segment whose text changed gets its cached audio dropped for re-bake.
//
// Usage:  node scripts/build_user_study.mjs
// Then:   node scripts/bake_multimedia.mjs --lecture userstudy_L1 --deterministic-utts

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const line of fs.readFileSync(path.join(ROOT, 'src/nexora_server/.env'), 'utf-8').split('\n')) {
  const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
}

const LECTURE_ID = 'userstudy_L1';
const COURSE_NAME = 'User Study';            // DB course (landing page)
const SPOKEN_COURSE = 'Image Compression';   // "Welcome to …" + Q&A prompt context
const TITLE = 'How JPEG Image Compression Works';
const SOURCE_PDF = 'Lecture 3 (Compression).pdf';
const LANGS = ['en', 'ar', 'fr', 'de', 'es', 'zh'];
// One entry per paragraph, in script order: [section title, PDF page].
const SEGMENTS = [
  ['Digital Images', 17],
  ['Why Compression Matters', 23],
  ['What Is JPEG?', 26],
  ['Preparing the Image', 44],
  ['Understanding DCT', 45],
  ['DCT Coefficients', 46],
  ['Quantization', 48],
  ['Quantization Example', 49],
  ['Zig-Zag Scanning', 50],
  ['Run-Length Encoding', 52],
  ['Huffman Coding', 54],
  ['Final Comparison and Recap', 55],
];

const SRC_DIR = path.join(ROOT, 'scripts', 'user_study');
const LEC_DIR = path.join(ROOT, 'profbrain', 'lectures', LECTURE_ID);
const CACHE_SEG = path.join(ROOT, 'src', 'nexora_ai', 'lecture_cache', 'segments');
const pad = (i) => `segment_${String(i).padStart(3, '0')}`;
const json = (p, v) => fs.writeFileSync(p, JSON.stringify(v, null, 2));
const fingerprint = (segs) => crypto.createHash('sha256')
  .update(segs.map((s) => `${s.id}:${s.text}`).join('\n')).digest('hex').slice(0, 16);

const scripts = {};
for (const lang of LANGS) {
  const paras = fs.readFileSync(path.join(SRC_DIR, `${lang}.txt`), 'utf-8')
    .split(/\n\s*\n+/).map((p) => p.trim()).filter(Boolean);
  if (paras.length !== SEGMENTS.length) {
    throw new Error(`${lang}.txt has ${paras.length} paragraphs, expected ${SEGMENTS.length}`);
  }
  scripts[lang] = paras;
}

// ---- lecture files ---------------------------------------------------------
fs.mkdirSync(path.join(LEC_DIR, 'slides'), { recursive: true });
fs.mkdirSync(path.join(LEC_DIR, 'translations'), { recursive: true });
fs.copyFileSync(path.join(ROOT, SOURCE_PDF),
  path.join(LEC_DIR, 'slides', SOURCE_PDF.replace(/[^a-zA-Z0-9._-]/g, '_')));

const segments = scripts.en.map((text, id) => ({
  id, section: SEGMENTS[id][0], document: SOURCE_PDF,
  page: SEGMENTS[id][1], slidePage: SEGMENTS[id][1], text,
}));
json(path.join(LEC_DIR, 'segments.json'), {
  lectureId: LECTURE_ID, title: TITLE, course: SPOKEN_COURSE, language: 'en',
  sourceDocument: SOURCE_PDF, version: 0, segments,
});
const narration = scripts.en.join('\n\n');
json(path.join(LEC_DIR, 'summary.json'), {
  lecture_id: LECTURE_ID, title: TITLE, text: narration,
  word_count: narration.split(/\s+/).filter(Boolean).length,
  model: 'manual', generated: false, created_at: new Date().toISOString(),
});
json(path.join(LEC_DIR, 'slide_map.json'), {
  documents: {},
  segments: Object.fromEntries(segments.map((s) => [String(s.id), { doc: SOURCE_PDF, page: s.page }])),
});
for (const lang of LANGS.filter((l) => l !== 'en')) {
  const segs = scripts[lang].map((text, id) => ({ id, text }));
  json(path.join(LEC_DIR, 'translations', `${lang}.json`), {
    lang, lectureId: LECTURE_ID, version: 0, basedOnVersion: 0,
    fingerprint: fingerprint(segs), edited: true, segments: segs,
  });
}

// ---- runtime text cache (the exact text TTS bakes, per language) -----------
let dropped = 0;
for (const lang of LANGS) {
  const dir = path.join(CACHE_SEG, lang === 'en' ? LECTURE_ID : `${LECTURE_ID}__${lang}`);
  fs.mkdirSync(dir, { recursive: true });
  scripts[lang].forEach((text, i) => {
    const txt = path.join(dir, `${pad(i)}.txt`);
    if (fs.existsSync(txt) && fs.readFileSync(txt, 'utf-8') !== text) {
      for (const f of [`${pad(i)}.wav`, `${pad(i)}_lipsync.json`]) {
        if (fs.existsSync(path.join(dir, f))) { fs.rmSync(path.join(dir, f)); dropped++; }
      }
    }
    fs.writeFileSync(txt, text);
  });
}

// ---- database: course owned by the super admin + one ready lecture ---------
const { initDb, getPool } = await import(path.join(ROOT, 'src/nexora_server/db/pool.mjs'));
await initDb();
const pool = getPool();
const { rows: [admin] } = await pool.query(
  `SELECT id FROM users WHERE role='SUPER_ADMIN' AND is_active ORDER BY created_at LIMIT 1`);
if (!admin) throw new Error('No active SUPER_ADMIN user found');
let { rows: [course] } = await pool.query(
  `SELECT id FROM courses WHERE name=$1 AND owner_id=$2`, [COURSE_NAME, admin.id]);
if (!course) {
  ({ rows: [course] } = await pool.query(
    `INSERT INTO courses (id, owner_id, name, scene) VALUES ($1,$2,$3,'Multimedia') RETURNING id`,
    [crypto.randomUUID(), admin.id, COURSE_NAME]));
}
const manifest = { title: TITLE, topics: [], lectureId: LECTURE_ID };
const artifacts = { script: 1, slides: 1, validation: { ok: true, problems: [] } };
const { rows: [lec] } = await pool.query(
  `SELECT id FROM course_lectures WHERE lecture_id=$1`, [LECTURE_ID]);
if (lec) {
  await pool.query(
    `UPDATE course_lectures SET course_id=$2, idx=1, title=$3, status='ready', manifest=$4,
            artifacts = COALESCE(artifacts,'{}'::jsonb) || $5::jsonb WHERE id=$1`,
    [lec.id, course.id, TITLE, JSON.stringify(manifest), JSON.stringify(artifacts)]);
} else {
  await pool.query(
    `INSERT INTO course_lectures (id, course_id, idx, lecture_id, title, status, manifest, artifacts)
     VALUES ($1,$2,1,$3,$4,'ready',$5,$6)`,
    [crypto.randomUUID(), course.id, LECTURE_ID, TITLE, JSON.stringify(manifest), JSON.stringify(artifacts)]);
}
await pool.end();

console.log(`[user-study] ${LECTURE_ID}: ${segments.length} segments × ${LANGS.length} languages written`);
console.log(`[user-study] course "${COURSE_NAME}" id=${course.id} owner=${admin.id}`);
if (dropped) console.log(`[user-study] dropped ${dropped} stale audio file(s) for changed text`);
