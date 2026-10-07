import express from 'express';
import fs from 'fs/promises';
import { existsSync, readdirSync } from 'fs';
import { createHash } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { generate as generateOllama } from '../modules/ollamaClient.mjs';
import { getDefaultVoice, synthesize as synthesizeTTS, synthesizeVerified } from '../modules/voxcpmClient.mjs';
import { wavDurationMs } from '../modules/audioUtils.mjs';
import { execCommand } from '../utils/files.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

const LECTURE_DATA = path.join(__dirname, '..', 'data', 'multimediaLectures.json');
const CACHE_DIR = path.join(__dirname, '..', 'lecture_cache');
const SEGMENTS_CACHE = path.join(__dirname, '..', 'lecture_cache', 'segments');
const ANSWERS_DIR = path.join(__dirname, '..', 'lecture_cache', 'answers');
const PROFBRAIN_DIR = path.join(__dirname, '..', '..', '..', 'profbrain', 'lectures');
const PDFS_BASE = path.join(__dirname, '..', 'data', 'courses');
const RHUBARB_BIN = path.join(__dirname, '..', 'bin', 'rhubarb');

const ANIMATIONS = ['explain', 'explain2', 'explain3'];
const EXPRESSIONS = ['smile', 'neutral', 'smile', 'happy'];

function findLecturePdf(lectureId, course = 'Multimedia') {
  const n = Number(lectureId.replace(/\D/g, ''));
  const pdfDir = path.join(PDFS_BASE, course);
  if (!existsSync(pdfDir)) return null;
  const files = readdirSync(pdfDir);
  const match = files.find((f) => {
    const lower = f.toLowerCase();
    return lower.endsWith('.pdf') && (lower.includes(`lecture${n}`) || lower.includes(`lecture_${n}`));
  });
  return match ? path.join(pdfDir, match) : null;
}

let lecturesCache = null;

async function ensureCacheDir() {
  if (!existsSync(CACHE_DIR)) {
    await fs.mkdir(CACHE_DIR, { recursive: true });
  }
}

async function loadLectures() {
  if (lecturesCache) return lecturesCache;
  const raw = await fs.readFile(LECTURE_DATA, 'utf-8');
  const data = JSON.parse(raw);
  lecturesCache = data;
  return data;
}

function cacheTextPath(lectureId) {
  return path.join(CACHE_DIR, `${lectureId}.json`);
}

function cacheAudioPath(lectureId) {
  return path.join(CACHE_DIR, `${lectureId}.wav`);
}

async function loadCachedExplanation(lectureId) {
  const textPath = cacheTextPath(lectureId);
  if (!existsSync(textPath)) return null;
  try {
    const raw = await fs.readFile(textPath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function cacheExplanation(lectureId, title, text) {
  const textPath = cacheTextPath(lectureId);
  await fs.writeFile(textPath, JSON.stringify({
    lecture_id: lectureId,
    title,
    text,
    createdAt: new Date().toISOString(),
  }, null, 2));
}

function segmentCacheDir(lectureId) {
  return path.join(SEGMENTS_CACHE, lectureId);
}

function segmentAudioPath(lectureId, index) {
  return path.join(segmentCacheDir(lectureId), `segment_${String(index).padStart(3, '0')}.wav`);
}

function segmentLipSyncPath(lectureId, index) {
  return path.join(segmentCacheDir(lectureId), `segment_${String(index).padStart(3, '0')}_lipsync.json`);
}

function splitSummaryText(text, maxWords = 140) {
  const cleaned = text
    .replace(/^#{1,4}\s+/gm, '')
    .replace(/\*\*/g, '')
    .trim();

  const blocks = cleaned.split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean);

  const segments = [];
  for (const block of blocks) {
    const words = block.split(/\s+/);
    if (words.length <= maxWords * 1.6) {
      segments.push(block);
      continue;
    }

    const sentences = block.match(/[^.!?]+[.!?]+/g) || [block];
    let buffer = '';
    let bufferWords = 0;
    for (const sentence of sentences) {
      const sentenceWords = sentence.split(/\s+/).length;
      if (bufferWords + sentenceWords > maxWords && bufferWords > 0) {
        segments.push(buffer.trim());
        buffer = sentence.trim();
        bufferWords = sentenceWords;
      } else {
        buffer = buffer ? `${buffer} ${sentence.trim()}` : sentence.trim();
        bufferWords += sentenceWords;
      }
    }
    if (buffer.trim()) segments.push(buffer.trim());
  }

  const finalSegments = [];
  for (const seg of segments) {
    const words = seg.split(/\s+/);
    if (words.length <= maxWords * 1.6) {
      finalSegments.push(seg);
      continue;
    }
    for (let i = 0; i < words.length; i += maxWords) {
      finalSegments.push(words.slice(i, i + maxWords).join(' '));
    }
  }

  if (finalSegments.length === 0) {
    finalSegments.push(cleaned);
  }
  return finalSegments;
}

const LECTURE_LANGUAGES = {
  en: 'English',
  ar: 'Arabic',
  fr: 'French',
  de: 'German',
  es: 'Spanish',
  zh: 'Chinese',
  // 'hi' intentionally absent — VoxCPM2 produces garbled Hindi (verified);
  // re-enable only with a verified Hindi-capable voice/model.
};

function normalizeLang(lang) {
  return lang && LECTURE_LANGUAGES[lang] ? lang : 'en';
}

// Translate a lecture narration segment via Ollama. VoxCPM2 then detects the
// output language automatically at synthesis time (no tag needed).
async function translateForLecture(text, lang) {
  if (lang === 'en') return text;
  const prompt = `Translate the following lecture narration into ${LECTURE_LANGUAGES[lang]}. Keep the same warm, spoken-lecture style and roughly the same length. Output ONLY the translated narration — no notes, no headings, no commentary.\n\n${text}`;
  const out = await generateOllama(prompt, { numPredict: 800 });
  const translated = (out || '').trim();
  return translated || text;
}

function cleanTextForTts(text) {
  return text
    .replace(/\*\*/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\{[^}]*\}/g, '')
    .replace(/^\s*[-*•–]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Derive the language from a segment cacheKey ('Lecture_1' => 'en',
// 'Lecture_1__ar' => 'ar') so verified synthesis can check the output.
function langFromCacheKey(lectureId) {
  const m = /__(en|ar|fr|de|es|zh)$/.exec(lectureId || '');
  return m ? m[1] : 'en';
}

async function generateSegmentAudio(lectureId, index, text, lang = null) {
  const audioPath = segmentAudioPath(lectureId, index);
  const lipsyncPath = segmentLipSyncPath(lectureId, index);
  const ttsText = cleanTextForTts(text);

  if (existsSync(audioPath) && existsSync(lipsyncPath)) {
    try {
      return { audioPath, lipsync: JSON.parse(await fs.readFile(lipsyncPath, 'utf-8')) };
    } catch (err) {
      console.error(`[segments] Cached lipsync invalid for ${lectureId}/${index}:`, err);
    }
    return { audioPath, lipsync: null };
  }

  const voiceId = await getDefaultVoice();
  if (!voiceId) {
    throw new Error('No professor voice configured');
  }

  const dir = segmentCacheDir(lectureId);
  if (!existsSync(dir)) {
    await fs.mkdir(dir, { recursive: true });
  }

  let audioBuffer = null;
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      audioBuffer = await synthesizeVerified(ttsText, voiceId, lang || langFromCacheKey(lectureId));
      break;
    } catch (err) {
      lastError = err;
      console.error(`[segments] TTS attempt ${attempt + 1} failed for ${lectureId}/${index}:`, err.message || err);
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
  if (!audioBuffer) {
    throw lastError || new Error('TTS generation failed');
  }
  await fs.writeFile(audioPath, audioBuffer);

  if (!existsSync(lipsyncPath)) {
    try {
      await execCommand({
        command: `${RHUBARB_BIN} -f json -o "${lipsyncPath}" "${audioPath}" -r phonetic`,
      });
    } catch (err) {
      console.error(`[segments] Rhubarb failed for ${lectureId}/${index}:`, err);
      // Continue without lipsync
    }
  }

  let lipsync = null;
  if (existsSync(lipsyncPath)) {
    try {
      lipsync = JSON.parse(await fs.readFile(lipsyncPath, 'utf-8'));
    } catch (err) {
      console.error(`[segments] Lipsync parse failed for ${lectureId}/${index}:`, err);
    }
  }
  return { audioPath, lipsync };
}

// Optional deterministic segment→PDF-page map. Language-independent: it is
// keyed on the shared logical segment index, not on translated text.
async function loadSlideMap(lectureId) {
  const mapPath = path.join(PROFBRAIN_DIR, lectureId, 'slide_map.json');
  if (!existsSync(mapPath)) return null;
  try {
    const map = JSON.parse(await fs.readFile(mapPath, 'utf-8'));
    return map?.segments && typeof map.segments === 'object' ? map.segments : null;
  } catch (err) {
    console.error(`[segments] slide_map invalid for ${lectureId}:`, err);
    return null;
  }
}

async function loadLectureManifest(lectureId, lang = 'en') {
  const summaryPath = path.join(PROFBRAIN_DIR, lectureId, 'summary.json');
  if (!existsSync(summaryPath)) {
    throw new Error(`Summary not found for ${lectureId}`);
  }

  const summary = JSON.parse(await fs.readFile(summaryPath, 'utf-8'));
  const slideMap = await loadSlideMap(lectureId);
  // Language-keyed cache dir: English keeps the original layout, translated
  // lectures get their own audio/lipsync cache (e.g. segments/Lecture_1__ar).
  const cacheKey = lang === 'en' ? lectureId : `${lectureId}__${lang}`;

  // Every language must return the SAME segmented manifest — seg.id indexes
  // the shared logical position. A single-segment English shortcut breaks
  // NCIP mid-lecture language switching: switches away rebuild from seg 0,
  // and switching back yields an empty filtered manifest (nothing plays).
  const texts = splitSummaryText(summary.text);
  const segments = [];
  for (let i = 0; i < texts.length; i++) {
    const audioPath = segmentAudioPath(cacheKey, i);
    const lipsyncPath = segmentLipSyncPath(cacheKey, i);
    const textPath = path.join(segmentCacheDir(cacheKey), `segment_${String(i).padStart(3, '0')}.txt`);

    // Fast path: translated text + audio + lipsync all cached — no LLM/TTS.
    let segText = null;
    let lipsync = null;
    if (existsSync(textPath) && existsSync(audioPath) && existsSync(lipsyncPath)) {
      try {
        segText = await fs.readFile(textPath, 'utf-8');
        lipsync = JSON.parse(await fs.readFile(lipsyncPath, 'utf-8'));
      } catch (err) {
        console.error(`[segments] Cache read failed for ${cacheKey}/${i}:`, err);
        segText = null;
      }
    }

    // Audio exists but the translated text wasn't persisted (older bake):
    // serve the audio now and fill the text cache in the background so the
    // NEXT request shows the translated transcript.
    if (segText === null && lang !== 'en' && existsSync(audioPath) && existsSync(lipsyncPath)) {
      segText = texts[i];
      try {
        lipsync = JSON.parse(await fs.readFile(lipsyncPath, 'utf-8'));
      } catch {}
      const srcText = texts[i];
      translateForLecture(srcText, lang)
        .then((t) => fs.writeFile(textPath, t))
        .catch(() => {});
    }

    if (segText === null) {
      segText = await translateForLecture(texts[i], lang);
      // Persist the segment text so the audio endpoint can synthesize lazily.
      const dir = segmentCacheDir(cacheKey);
      if (!existsSync(dir)) await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(textPath, segText).catch(() => {});
    }
    // Audio/lipsync are generated lazily by /lecture/segment_audio on first
    // play — building all segments' TTS inside the manifest request blocks
    // Start Class for minutes on uncached lectures/languages.
    if (!lipsync && existsSync(lipsyncPath)) {
      try {
        lipsync = JSON.parse(await fs.readFile(lipsyncPath, 'utf-8'));
      } catch {}
    }
    segments.push({
      id: i,
      title: i === 0 ? summary.title : `Segment ${i + 1}`,
      text: segText,
      animation: ANIMATIONS[i % ANIMATIONS.length],
      facialExpression: EXPRESSIONS[i % EXPRESSIONS.length],
      audioUrl: `/api/lecture/segment_audio/${cacheKey}/${i}`,
      lipsync,
      slidePage: slideMap ? (Number(slideMap[String(i)]) || null) : null,
    });
  }

  return {
    lectureId,
    title: summary.title,
    language: lang,
    segments,
  };
}

function buildPrompt(lecture) {
  return `You are a university professor teaching a course on Multimedia Computing.

Lecture: ${lecture.title}
Material:
${lecture.content}

Give a warm, engaging spoken introduction to this lecture in about 120 words. Explain the key topics in plain language, as if speaking directly to a student. Keep it conversational and easy to follow, and end with one complete sentence.`;
}

router.get('/lectures', async (req, res) => {
  try {
    const data = await loadLectures();
    res.json({
      course: { course_id: data.course_id, title: data.title },
      lectures: data.lectures.map((l) => ({
        lecture_id: l.lecture_id,
        title: l.title,
        subtitle: l.subtitle,
        learning_objectives: l.learning_objectives,
      })),
    });
  } catch (error) {
    console.error('[lectures] failed:', error);
    res.status(500).json({ error: 'Failed to load lectures' });
  }
});

router.post('/lecture/explain', async (req, res) => {
  await ensureCacheDir();

  const { lectureId, voiceId } = req.body || {};
  if (!lectureId) {
    return res.status(400).json({ error: 'lectureId is required' });
  }

  const data = await loadLectures();
  const lecture = data.lectures.find((l) => l.lecture_id === lectureId);
  if (!lecture) {
    return res.status(404).json({ error: 'Lecture not found' });
  }

  const audioPath = cacheAudioPath(lectureId);

  // Return from cache if both exist
  const cached = await loadCachedExplanation(lectureId);
  if (cached && existsSync(audioPath)) {
    return res.json({
      lecture_id: lectureId,
      title: lecture.title,
      text: cached.text,
      audioUrl: `/api/lecture/audio/${lectureId}`,
      cached: true,
    });
  }

  try {
    const explanation = await generateOllama(buildPrompt(lecture), { numPredict: 180 });
    if (!explanation) {
      throw new Error('Ollama returned empty explanation');
    }

    const selectedVoice = voiceId || (await getDefaultVoice()) || '';
    if (!selectedVoice) {
      throw new Error('No voice_id provided and no voices registered in VoxCPM');
    }

    console.log(`[lecture] TTS for ${lectureId} with voice ${selectedVoice}`);
    const audioBuffer = await synthesizeTTS(explanation, selectedVoice);
    await fs.writeFile(audioPath, audioBuffer);
    await cacheExplanation(lectureId, lecture.title, explanation);

    res.json({
      lecture_id: lectureId,
      title: lecture.title,
      text: explanation,
      audioUrl: `/api/lecture/audio/${lectureId}`,
      cached: false,
    });
  } catch (error) {
    console.error('[lecture/explain] failed:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/lecture/audio/:lectureId', async (req, res) => {
  const { lectureId } = req.params;
  const audioPath = cacheAudioPath(lectureId);
  if (!existsSync(audioPath)) {
    return res.status(404).json({ error: 'Audio not found' });
  }
  res.set('Content-Type', 'audio/wav');
  res.sendFile(audioPath, { root: '/' });
});

router.get('/lecture/summary/:lectureId', async (req, res) => {
  const { lectureId } = req.params;
  const summaryPath = path.join(PROFBRAIN_DIR, lectureId, 'summary.json');
  const audioPath = path.join(PROFBRAIN_DIR, lectureId, 'summary.wav');

  if (!existsSync(summaryPath)) {
    return res.status(404).json({ error: 'Summary not found' });
  }

  const summary = JSON.parse(await fs.readFile(summaryPath, 'utf-8'));

  if (!existsSync(audioPath)) {
    try {
      const voiceId = await getDefaultVoice();
      if (!voiceId) {
        throw new Error('No professor voice configured');
      }
      console.log(`[lecture/summary] Generating audio for ${lectureId} with voice ${voiceId}`);
      const audioBuffer = await synthesizeTTS(summary.text, voiceId);
      await fs.writeFile(audioPath, audioBuffer);
    } catch (err) {
      console.error(`[lecture/summary] Failed to generate audio for ${lectureId}:`, err);
    }
  }

  const audioReady = existsSync(audioPath);
  let lipsync = null;

  if (audioReady) {
    const lipsyncPath = path.join(PROFBRAIN_DIR, lectureId, 'lipsync.json');
    if (!existsSync(lipsyncPath)) {
      try {
        await execCommand({
          command: `${RHUBARB_BIN} -f json -o "${lipsyncPath}" "${audioPath}" -r phonetic`,
        });
      } catch (err) {
        console.error(`[lecture/summary] Rhubarb failed for ${lectureId}:`, err);
      }
    }
    if (existsSync(lipsyncPath)) {
      try {
        lipsync = JSON.parse(await fs.readFile(lipsyncPath, 'utf-8'));
      } catch (err) {
        console.error(`[lecture/summary] Failed to read lipsync for ${lectureId}:`, err);
      }
    }
  }

  res.json({
    lecture_id: lectureId,
    title: summary.title,
    text: summary.text,
    audioUrl: audioReady ? `/api/lecture/summary_audio/${lectureId}` : null,
    animation: 'explain',
    facialExpression: 'smile',
    lipsync,
    cached: audioReady,
  });
});

router.get('/lecture/summary_audio/:lectureId', async (req, res) => {
  const { lectureId } = req.params;
  const audioPath = path.join(PROFBRAIN_DIR, lectureId, 'summary.wav');
  if (!existsSync(audioPath)) {
    return res.status(404).json({ error: 'Summary audio not found' });
  }
  res.set('Content-Type', 'audio/wav');
  res.sendFile(audioPath, { root: '/' });
});

router.get('/lecture/pdf/:lectureId', (req, res) => {
  const { lectureId } = req.params;
  const course = req.query.course || 'Multimedia';
  const pdfPath = findLecturePdf(lectureId, course);
  if (!pdfPath || !existsSync(pdfPath)) {
    console.log(`[lecture/pdf] Missing PDF for lectureId=${lectureId} course=${course}`);
    return res.status(404).json({ error: `PDF not found for ${lectureId}` });
  }
  res.set('Content-Type', 'application/pdf');
  res.sendFile(pdfPath, { root: '/' });
});

router.get('/lecture/pdf_image/:lectureId', async (req, res) => {
  const { lectureId } = req.params;
  const course = req.query.course || 'Multimedia';
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const pdfPath = findLecturePdf(lectureId, course);
  if (!pdfPath || !existsSync(pdfPath)) {
    console.log(`[lecture/pdf_image] Missing PDF for lectureId=${lectureId} course=${course}`);
    return res.status(404).json({ error: `PDF not found for ${lectureId}` });
  }

  await ensureCacheDir();
  // Page 1 keeps the legacy cache filename; other pages get a per-page key.
  const suffix = page === 1 ? '' : `_p${page}`;
  const outBase = path.join(CACHE_DIR, `${course}_${lectureId}_slide${suffix}`);
  const outPng = `${outBase}.png`;

  if (!existsSync(outPng)) {
    try {
      await execCommand({
        command: `pdftoppm -png -f ${page} -l ${page} -r 96 -singlefile "${pdfPath}" "${outBase}"`,
      });
    } catch (err) {
      console.error(`[lecture/pdf_image] Failed for ${lectureId}:`, err);
      return res.status(500).json({ error: 'Failed to render PDF slide' });
    }
  }

  if (!existsSync(outPng)) {
    return res.status(500).json({ error: 'PNG not generated' });
  }

  res.set('Content-Type', 'image/png');
  res.sendFile(outPng, { root: '/' });
});

router.get('/lecture/segments/:lectureId', async (req, res) => {
  const { lectureId } = req.params;
  const lang = normalizeLang(req.query.lang);
  try {
    const manifest = await loadLectureManifest(lectureId, lang);
    res.json(manifest);
  } catch (error) {
    console.error(`[lecture/segments] ${lectureId} failed:`, error);
    res.status(500).json({ error: error.message || 'Failed to load lecture segments' });
  }
});

router.get('/lecture/segment_audio/:lectureId/:segmentId', async (req, res) => {
  const { lectureId, segmentId } = req.params;
  const index = Number(segmentId);
  const audioPath = segmentAudioPath(lectureId, index);
  // Lazy generation: manifests no longer pre-bake audio, so a first-play miss
  // synthesizes (and caches) the segment on demand from its persisted text.
  if (!existsSync(audioPath)) {
    const textPath = path.join(segmentCacheDir(lectureId), `segment_${String(index).padStart(3, '0')}.txt`);
    if (!existsSync(textPath)) {
      return res.status(404).json({ error: 'Segment audio not found' });
    }
    try {
      const segText = await fs.readFile(textPath, 'utf-8');
      await generateSegmentAudio(lectureId, index, segText);
    } catch (err) {
      console.error(`[segments] lazy TTS failed for ${lectureId}/${index}:`, err);
      return res.status(500).json({ error: 'Segment audio generation failed' });
    }
  }
  if (!existsSync(audioPath)) {
    return res.status(404).json({ error: 'Segment audio not found' });
  }
  res.set('Content-Type', 'audio/wav');
  res.sendFile(audioPath, { root: '/' });
});

// The answer MUST be in the authoritative room language regardless of the
// language the question was asked in. Exported for unit tests.
export function buildAskPrompt(context, question, lang) {
  return `You are Professor Abed, a warm university professor teaching Multimedia Computing. A student interrupts your lecture to ask a question. Answer clearly and briefly in 2-4 spoken-style sentences. You must answer ONLY in ${LECTURE_LANGUAGES[lang] || 'English'} — even if the question is asked in another language, never switch languages. Plain text only — no markdown, no lists, no citations.

${context}

Student question: ${question}`;
}

// Student question during a lecture: Ollama answer + VoxCPM2 (abed101) + Rhubarb.
// Cached per (lectureId, question) so repeated interruptions are instant.
router.post('/ask', async (req, res) => {
  const { question, lectureId, language } = req.body || {};
  if (!question || typeof question !== 'string' || !question.trim()) {
    return res.status(400).json({ error: 'question required' });
  }
  if (language != null && !LECTURE_LANGUAGES[language]) {
    return res.status(400).json({ error: `Unsupported language '${language}'` });
  }
  const lang = normalizeLang(language);
  try {
    let context = '';
    if (lectureId) {
      try {
        const summaryPath = path.join(PROFBRAIN_DIR, lectureId, 'summary.json');
        if (existsSync(summaryPath)) {
          const summary = JSON.parse(await fs.readFile(summaryPath, 'utf-8'));
          context = `Current lecture: ${summary.title}. Content excerpt: ${summary.text.slice(0, 1500)}`;
        }
      } catch (err) {
        console.error(`[ask] could not load context for ${lectureId}:`, err);
      }
    }

    const prompt = buildAskPrompt(context, question, lang);

    let answerText = (await generateOllama(prompt, { temperature: 0.6, numPredict: 220 })).trim();
    if (!answerText) {
      answerText = "That's a good question. Let me make sure I cover it during the rest of the lecture.";
    }

    const key = createHash('md5')
      .update(`${lectureId || 'general'}::${lang}::${question.trim().toLowerCase()}`)
      .digest('hex');
    const audioPath = path.join(ANSWERS_DIR, `${key}.wav`);
    const lipsyncPath = path.join(ANSWERS_DIR, `${key}_lipsync.json`);

    if (!(existsSync(audioPath) && existsSync(lipsyncPath))) {
      if (!existsSync(ANSWERS_DIR)) {
        await fs.mkdir(ANSWERS_DIR, { recursive: true });
      }
      const voiceId = await getDefaultVoice();
      if (!voiceId) {
        throw new Error('No professor voice configured');
      }
      const audioBuffer = await synthesizeVerified(cleanTextForTts(answerText), voiceId, lang);
      await fs.writeFile(audioPath, audioBuffer);
      try {
        await execCommand({
          command: `${RHUBARB_BIN} -f json -o "${lipsyncPath}" "${audioPath}" -r phonetic`,
        });
      } catch (err) {
        console.error('[ask] Rhubarb failed:', err);
      }
    }

    let lipsync = null;
    if (existsSync(lipsyncPath)) {
      try {
        lipsync = JSON.parse(await fs.readFile(lipsyncPath, 'utf-8'));
      } catch (err) {
        console.error('[ask] Lipsync parse failed:', err);
      }
    }

    let durationMs = null;
    try {
      durationMs = wavDurationMs(await fs.readFile(audioPath));
    } catch (err) {
      console.error('[ask] duration parse failed:', err);
    }

    res.json({
      messages: [{
        text: answerText,
        animation: 'explain',
        facialExpression: 'smile',
        audioUrl: `/api/lecture/answer_audio/${key}`,
        durationMs,
        lipsync,
      }],
    });
  } catch (error) {
    console.error('[ask] failed:', error);
    res.status(500).json({ error: error.message || 'Failed to answer question' });
  }
});

// lectureId is used to build filesystem paths — accept only safe characters.
const LECTURE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

// Validate a recap request and resolve the actual segment texts it covers.
// Returns { status, error } on failure or { lang, texts } on success. Exported
// for unit tests — performs no LLM/TTS work itself.
async function resolveRecapMaterial(lectureId, language, fromSegment, toSegment) {
  if (typeof lectureId !== 'string' || !LECTURE_ID_RE.test(lectureId)) {
    return { status: 400, error: 'Invalid lectureId' };
  }
  if (language != null && typeof language === 'string' && !LECTURE_LANGUAGES[language]) {
    return { status: 400, error: `Unsupported language '${language}'` };
  }
  if (!Number.isInteger(fromSegment) || !Number.isInteger(toSegment)) {
    return { status: 400, error: 'fromSegment and toSegment must be integers' };
  }
  if (fromSegment < 0 || toSegment < fromSegment) {
    return { status: 400, error: 'Invalid segment range' };
  }
  const lang = normalizeLang(language);
  let manifest;
  try {
    manifest = await loadLectureManifest(lectureId, lang);
  } catch {
    return { status: 404, error: `Lecture '${lectureId}' not found` };
  }
  if (toSegment >= manifest.segments.length) {
    return { status: 400, error: `toSegment ${toSegment} is beyond the manifest (${manifest.segments.length} segments)` };
  }
  const texts = manifest.segments
    .slice(fromSegment, toSegment + 1)
    .map((s) => s.text)
    .filter(Boolean);
  if (texts.length === 0) {
    return { status: 400, error: 'Empty recap range' };
  }
  return { lang, texts };
}

// Cache key includes a hash of the actual source text so a regenerated lecture
// with the same lectureId/range can never replay an obsolete recap.
function recapCacheKey(cacheKey, from, to, material) {
  const materialHash = createHash('md5').update(material).digest('hex');
  return createHash('md5').update(`${cacheKey}::recap::${from}-${to}::${materialHash}`).digest('hex');
}

export { resolveRecapMaterial, recapCacheKey };

// Late-joiner catch-up: summarize the contiguous segment range a participant
// missed (segments fromSegment..toSegment inclusive, normally 0..anchor) as a
// short spoken recap in the room language. Returns the exact message shape of
// /ask so the NCIP floor-answer pipeline broadcasts it unchanged.
router.post('/recap', async (req, res) => {
  const { lectureId, language, fromSegment, toSegment } = req.body || {};
  try {
    const resolved = await resolveRecapMaterial(lectureId, language, fromSegment, toSegment);
    if (resolved.error) {
      return res.status(resolved.status).json({ error: resolved.error });
    }
    const { lang, texts } = resolved;
    const material = texts.join('\n\n');

    const prompt = `You are Professor Abed, a warm university professor teaching Multimedia Computing. A student just joined your lecture late and missed what you already covered. In ${LECTURE_LANGUAGES[lang]}, give them a quick spoken catch-up: summarize ONLY the material below into at most 3-4 short sentences, keeping the important concepts. Do not mention "the text", "the material", or that this is a summary — speak naturally as yourself catching the student up, then say you will now continue with the rest of the class. Plain text only — no markdown, no lists.

Material covered so far:
${material}`;

    let recapText = (await generateOllama(prompt, { temperature: 0.6, numPredict: 220 })).trim();
    if (!recapText) {
      recapText = "You have only missed the opening remarks — let's pick it up from here together.";
    }

    // Cached per (lecture, language, range, content) — identical inputs replay
    // instantly; edited lecture content produces a different key.
    const cacheKey = lang === 'en' ? lectureId : `${lectureId}__${lang}`;
    const key = recapCacheKey(cacheKey, fromSegment, toSegment, material);
    const audioPath = path.join(ANSWERS_DIR, `${key}.wav`);
    const lipsyncPath = path.join(ANSWERS_DIR, `${key}_lipsync.json`);

    if (!(existsSync(audioPath) && existsSync(lipsyncPath))) {
      if (!existsSync(ANSWERS_DIR)) {
        await fs.mkdir(ANSWERS_DIR, { recursive: true });
      }
      const voiceId = await getDefaultVoice();
      if (!voiceId) {
        throw new Error('No professor voice configured');
      }
      const audioBuffer = await synthesizeVerified(cleanTextForTts(recapText), voiceId, lang);
      await fs.writeFile(audioPath, audioBuffer);
      try {
        await execCommand({
          command: `${RHUBARB_BIN} -f json -o "${lipsyncPath}" "${audioPath}" -r phonetic`,
        });
      } catch (err) {
        console.error('[recap] Rhubarb failed:', err);
      }
    }

    let lipsync = null;
    if (existsSync(lipsyncPath)) {
      try {
        lipsync = JSON.parse(await fs.readFile(lipsyncPath, 'utf-8'));
      } catch (err) {
        console.error('[recap] Lipsync parse failed:', err);
      }
    }

    let durationMs = null;
    try {
      durationMs = wavDurationMs(await fs.readFile(audioPath));
    } catch (err) {
      console.error('[recap] duration parse failed:', err);
    }

    res.json({
      messages: [{
        text: recapText,
        animation: 'explain',
        facialExpression: 'smile',
        audioUrl: `/api/lecture/answer_audio/${key}`,
        durationMs,
        lipsync,
      }],
    });
  } catch (error) {
    console.error('[recap] failed:', error);
    res.status(500).json({ error: error.message || 'Failed to build recap' });
  }
});

router.get('/lecture/answer_audio/:key', async (req, res) => {
  const { key } = req.params;
  const audioPath = path.join(ANSWERS_DIR, `${key}.wav`);
  if (!/^[a-f0-9]{32}$/.test(key) || !existsSync(audioPath)) {
    return res.status(404).json({ error: 'Answer audio not found' });
  }
  res.set('Content-Type', 'audio/wav');
  res.sendFile(audioPath, { root: '/' });
});

export default router;
