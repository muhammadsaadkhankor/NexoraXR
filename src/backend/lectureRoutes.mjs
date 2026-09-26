import express from 'express';
import fs from 'fs/promises';
import { existsSync, readdirSync } from 'fs';
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
const PROFBRAIN_DIR = path.join(__dirname, '..', '..', 'profbrain', 'lectures');
const PDFS_DIR = path.join(__dirname, '..', '..', 'profbrain', 'raw_pdfs');

function findLecturePdf(lectureId) {
  const n = Number(lectureId.replace(/\D/g, ''));
  if (!existsSync(PDFS_DIR)) return null;
  const files = readdirSync(PDFS_DIR);
  const match = files.find((f) => {
    const lower = f.toLowerCase();
    return lower.endsWith('.pdf') && (lower.includes(`lecture${n}`) || lower.includes(`lecture_${n}`));
  });
  return match ? path.join(PDFS_DIR, match) : null;
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
      const voiceId = await getDefaultVoice('prof');
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
  const pdfPath = findLecturePdf(lectureId);
  if (!pdfPath || !existsSync(pdfPath)) {
    return res.status(404).json({ error: 'PDF not found' });
  }
  res.set('Content-Type', 'application/pdf');
  res.sendFile(pdfPath, { root: '/' });
});

router.get('/lecture/pdf_image/:lectureId', async (req, res) => {
  const { lectureId } = req.params;
  const pdfPath = findLecturePdf(lectureId);
  if (!pdfPath || !existsSync(pdfPath)) {
    console.log(`[lecture/pdf_image] Missing PDF for lectureId=${lectureId} (looked in ${PDFS_DIR})`);
    return res.status(404).json({ error: `PDF not found for ${lectureId}` });
  }

  await ensureCacheDir();
  const outBase = path.join(CACHE_DIR, `${lectureId}_slide`);
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

export default router;
