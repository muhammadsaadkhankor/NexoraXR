import express from 'express';
import fs from 'fs/promises';
import { existsSync, readdirSync } from 'fs';
import { createHash } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { generate as generateOllama } from './modules/ollamaClient.mjs';
import { getDefaultVoice, synthesize as synthesizeTTS } from './modules/cosyVoiceClient.mjs';
import { execCommand } from './utils/files.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

const LECTURE_DATA = path.join(__dirname, 'data', 'multimediaLectures.json');
const CACHE_DIR = path.join(__dirname, 'lecture_cache');
const SEGMENTS_CACHE = path.join(__dirname, 'lecture_cache', 'segments');
const ANSWERS_DIR = path.join(__dirname, 'lecture_cache', 'answers');
const PROFBRAIN_DIR = path.join(__dirname, '..', '..', 'profbrain', 'lectures');
const PDFS_BASE = path.join(__dirname, '..', 'assets', 'courses');

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

async function generateSegmentAudio(lectureId, index, text) {
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

  const voiceId = await getDefaultVoice('abed101');
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
      audioBuffer = await synthesizeTTS(ttsText, voiceId);
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
        command: `./bin/rhubarb -f json -o "${lipsyncPath}" "${audioPath}" -r phonetic`,
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

async function loadLectureManifest(lectureId) {
  const summaryPath = path.join(PROFBRAIN_DIR, lectureId, 'summary.json');
  if (!existsSync(summaryPath)) {
    throw new Error(`Summary not found for ${lectureId}`);
  }

  const summary = JSON.parse(await fs.readFile(summaryPath, 'utf-8'));
  const existingAudioPath = path.join(PROFBRAIN_DIR, lectureId, 'summary.wav');
  const existingLipsyncPath = path.join(PROFBRAIN_DIR, lectureId, 'lipsync.json');

  if (existsSync(existingAudioPath)) {
    let lipsync = null;
    if (existsSync(existingLipsyncPath)) {
      try {
        lipsync = JSON.parse(await fs.readFile(existingLipsyncPath, 'utf-8'));
      } catch (err) {
        console.error(`[segments] Failed to read lipsync for ${lectureId}:`, err);
      }
    }

    return {
      lectureId,
      title: summary.title,
      segments: [{
        id: 0,
        title: summary.title,
        text: summary.text,
        animation: 'explain',
        facialExpression: 'smile',
        audioUrl: `/api/lecture/summary_audio/${lectureId}`,
        lipsync,
      }],
    };
  }

  const texts = splitSummaryText(summary.text);
  const segments = [];
  for (let i = 0; i < texts.length; i++) {
    const { audioPath, lipsync } = await generateSegmentAudio(lectureId, i, texts[i]);
    segments.push({
      id: i,
      title: i === 0 ? summary.title : `Segment ${i + 1}`,
      text: texts[i],
      animation: ANIMATIONS[i % ANIMATIONS.length],
      facialExpression: EXPRESSIONS[i % EXPRESSIONS.length],
      audioUrl: `/api/lecture/segment_audio/${lectureId}/${i}`,
      lipsync,
    });
  }

  return {
    lectureId,
    title: summary.title,
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
      throw new Error('No voice_id provided and no voices registered in CosyVoice');
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
      const voiceId = await getDefaultVoice('abed101');
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
          command: `./bin/rhubarb -f json -o "${lipsyncPath}" "${audioPath}" -r phonetic`,
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
  const pdfPath = findLecturePdf(lectureId, course);
  if (!pdfPath || !existsSync(pdfPath)) {
    console.log(`[lecture/pdf_image] Missing PDF for lectureId=${lectureId} course=${course}`);
    return res.status(404).json({ error: `PDF not found for ${lectureId}` });
  }

  await ensureCacheDir();
  const outBase = path.join(CACHE_DIR, `${course}_${lectureId}_slide`);
  const outPng = `${outBase}.png`;

  if (!existsSync(outPng)) {
    try {
      await execCommand({
        command: `pdftoppm -png -f 1 -l 1 -r 96 -singlefile "${pdfPath}" "${outBase}"`,
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
  try {
    const manifest = await loadLectureManifest(lectureId);
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
  if (!existsSync(audioPath)) {
    return res.status(404).json({ error: 'Segment audio not found' });
  }
  res.set('Content-Type', 'audio/wav');
  res.sendFile(audioPath, { root: '/' });
});

// Student question during a lecture: Ollama answer + CosyVoice (abed101) + Rhubarb.
// Cached per (lectureId, question) so repeated interruptions are instant.
router.post('/ask', async (req, res) => {
  const { question, lectureId } = req.body || {};
  if (!question || typeof question !== 'string' || !question.trim()) {
    return res.status(400).json({ error: 'question required' });
  }
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

    const prompt = `You are Professor Abed, a warm university professor teaching Multimedia Computing. A student interrupts your lecture to ask a question. Answer clearly and briefly in 2-4 spoken-style sentences. Plain text only — no markdown, no lists, no citations.

${context}

Student question: ${question}`;

    let answerText = (await generateOllama(prompt, { temperature: 0.6, numPredict: 220 })).trim();
    if (!answerText) {
      answerText = "That's a good question. Let me make sure I cover it during the rest of the lecture.";
    }

    const key = createHash('md5')
      .update(`${lectureId || 'general'}::${question.trim().toLowerCase()}`)
      .digest('hex');
    const audioPath = path.join(ANSWERS_DIR, `${key}.wav`);
    const lipsyncPath = path.join(ANSWERS_DIR, `${key}_lipsync.json`);

    if (!(existsSync(audioPath) && existsSync(lipsyncPath))) {
      if (!existsSync(ANSWERS_DIR)) {
        await fs.mkdir(ANSWERS_DIR, { recursive: true });
      }
      const voiceId = await getDefaultVoice('abed101');
      if (!voiceId) {
        throw new Error('No professor voice configured');
      }
      const audioBuffer = await synthesizeTTS(cleanTextForTts(answerText), voiceId);
      await fs.writeFile(audioPath, audioBuffer);
      try {
        await execCommand({
          command: `./bin/rhubarb -f json -o "${lipsyncPath}" "${audioPath}" -r phonetic`,
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

    res.json({
      messages: [{
        text: answerText,
        animation: 'explain',
        facialExpression: 'smile',
        audioUrl: `/api/lecture/answer_audio/${key}`,
        lipsync,
      }],
    });
  } catch (error) {
    console.error('[ask] failed:', error);
    res.status(500).json({ error: error.message || 'Failed to answer question' });
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
