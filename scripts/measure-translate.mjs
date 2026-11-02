// Translation timing probe — measures translateForLecture over a real
// lecture's canonical segments for every supported language.
// Usage: node scripts/measure-translate.mjs <lectureId> [lang1,lang2,...]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lectureId = process.argv[2] || 'gen_6bbf922e_L1';
const langs = process.argv[3] ? process.argv[3].split(',') : ['ar', 'fr', 'de', 'es', 'zh'];

const { translateForLecture } = await import(
  path.join(ROOT, 'src', 'nexora_ai', 'routes', 'lectureRoutes.mjs'));

const segsPath = path.join(ROOT, 'profbrain', 'lectures', lectureId, 'segments.json');
const parsed = JSON.parse(fs.readFileSync(segsPath, 'utf-8'));
const segments = parsed.segments;
console.log(`lecture=${lectureId} segments=${segments.length} model=${process.env.OLLAMA_TRANSLATE_MODEL || process.env.OLLAMA_MODEL || 'qwen2.5:7b'} num_gpu=${process.env.OLLAMA_NUM_GPU ?? 'unset'}`);

const total0 = Date.now();
const perLang = {};
for (const lang of langs) {
  const t0 = Date.now();
  const segMs = [];
  for (const s of segments) {
    const st = Date.now();
    try {
      await translateForLecture(s.text, lang);
      segMs.push(Date.now() - st);
    } catch (e) {
      segMs.push(Date.now() - st);
      console.log(`  seg ${s.id} FAILED after ${Date.now() - st}ms: ${e.message.slice(0, 120)}`);
    }
  }
  const ms = Date.now() - t0;
  perLang[lang] = { ms, segMs };
  const avg = Math.round(segMs.reduce((a, b) => a + b, 0) / segMs.length);
  console.log(`lang=${lang} total=${ms}ms avg_per_segment=${avg}ms  [${segMs.join(',')}]`);
}
console.log(`TOTAL translating_ms=${Date.now() - total0}`);
console.log('JSON ' + JSON.stringify({ lectureId, perLang, total: Date.now() - total0 }));
