import 'dotenv/config';
import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from 'fs/promises';
import { openAIChain, parser } from "../nexora_ai/modules/openAI.mjs";
import { lipSync } from "../nexora_ai/modules/lip-sync.mjs";
import { sendDefaultMessages, defaultResponse } from "../nexora_ai/modules/defaultMessages.mjs";
import { voice, initializeElevenLabs } from "../nexora_ai/modules/elevenLabs.mjs";
import { createServer } from "http";
import { Server } from "socket.io";
import lectureRouter, { loadLectureManifest, generateLectureUtterance } from "../nexora_ai/routes/lectureRoutes.mjs";
import { NcipRoom, ProfessorStatus } from "./protocol/ncipRoom.mjs";
import { randomUUID } from "node:crypto";
import { getLecturePlan } from "./agent/lecturePlan.mjs";
import { decide as professorDecide, validateAction } from "./agent/professorAgent.mjs";
import { classifyClarification } from "./agent/reexplainPolicy.mjs";
import {
  createProfessorMemory, recordTopicTaught, recordQuestion,
  incrementClarification, recordReexplanation, getProfessorMemorySummary,
} from "./agent/professorMemory.mjs";
import {
  createUserMemoryStore, recordLectureJoin, recordTopicSeen, recordTopicMissed,
  recordUserQuestion, recordUserClarification, recordUserReexplanation, recordUserGroupRecap,
  getUserLearningSummary, hydrateUserMemory,
} from "./agent/userLearningMemory.mjs";
import { dbAvailable, persist, queries } from "./persistence/userMemoryDb.mjs";
import { initDb, getPool } from "./db/pool.mjs";
import authRouter from "./auth/routes.mjs";
import { registerDocument, ingestDocument } from "./courses/pipeline.mjs";
import { startBuild, runBuild, runAudioPhase, runTranslationPhase, buildRunning, buildStatus, resumeInterrupted } from "./courses/builds.mjs";
import { loadLectureDraft, saveLectureDraft, saveLectureFullDraft, saveLectureLangDraft,
         loadLectureLangDraft, invalidateSegmentAudio, textFingerprintForBake,
         audioApprovalGate, TRANSLATION_LANGS } from "./courses/drafts.mjs";
import { planFromDocuments } from "./courses/generator.mjs";
import adminRouter from "./admin/routes.mjs";
import brandingRouter from "./branding/routes.mjs";
import { attachUser, socketAuth, requireAuth, requireRole } from "./auth/sessionMiddleware.mjs";
import { resolveGuestToken, mintGuestToken } from "./auth/passwordless.mjs";
import { RoomRegistry } from "./protocol/roomRegistry.mjs";

dotenv.config();

// Dev-only compatibility escape hatch: preserves the legacy client-supplied
// participantId/hostId trust model so e2e tests and manual NCIP demos can run
// without a database. NEVER set in a real deployment — off by default.
const DEV_UNAUTH = process.env.NXR_DEV_UNAUTH_PROTOCOL === '1';
if (DEV_UNAUTH) console.warn('[auth] NXR_DEV_UNAUTH_PROTOCOL=1 — legacy unauthenticated identity enabled (DEV ONLY)');

const app = express();
app.use(express.json({ limit: '50mb' }));
// Credentialed CORS needs an explicit origin list — never '*'.
const CORS_ORIGINS = (process.env.CORS_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173')
  .split(',').map((o) => o.trim()).filter(Boolean);
app.use(cors({ origin: CORS_ORIGINS, credentials: true }));
app.use(attachUser);
app.use('/auth', authRouter);
app.use('/api/admin', adminRouter);
app.use('/api', brandingRouter);
const port = process.env.PORT || 3000;

// Legacy endpoints that predate auth stay open only while dev-compat is on or
// no database is configured (no accounts exist to gate against).
const legacyOrRole = (...roles) => (req, res, next) =>
  (DEV_UNAUTH || !dbAvailable() ? next() : requireRole(...roles)(req, res, next));

// Function to handle OpenAI response that might be an array or an object with a messages property
function normalizeOpenAIResponse(response) {
  if (Array.isArray(response)) {
    return { messages: response };
  } else if (response && response.messages && Array.isArray(response.messages)) {
    return response;
  } else if (response && typeof response === 'object') {
    // Last resort: try to extract any array-like property
    for (const key in response) {
      if (Array.isArray(response[key])) {
        return { messages: response[key] };
      }
    }
  }
  
  // If all else fails, return default response
  return { messages: defaultResponse };
}

// New endpoint to get current settings
app.get("/settings", legacyOrRole('SUPER_ADMIN'), async (req, res) => {
  try {
    const settings = {
      openaiModel: process.env.OPENAI_MODEL,
      openaiApiKey: process.env.OPENAI_API_KEY,
      elevenLabsApiKey: process.env.ELEVEN_LABS_API_KEY,
      elevenLabsVoiceId: process.env.ELEVEN_LABS_VOICE_ID,
      elevenLabsModelId: process.env.ELEVEN_LABS_MODEL_ID
    };
    res.status(200).json(settings);
  } catch (error) {
    console.error('Error getting settings:', error);
    res.status(500).json({ error: 'Failed to get settings' });
  }
});

// New endpoint to update settings
app.post("/settings", legacyOrRole('SUPER_ADMIN'), async (req, res) => {
  try {
    const newSettings = req.body;

    // Read current .env file content
    let currentEnv = {};
    try {
      const envContent = await fs.readFile('.env', 'utf-8');
      envContent.split('\n').forEach(line => {
        const [key, value] = line.split('=');
        if (key && value) {
          currentEnv[key.trim()] = value.trim();
        }
      });
    } catch (error) {
      console.log('No existing .env file found');
    }

    // Update only provided values
    const envContent = `# OPENAI
OPENAI_MODEL=${newSettings.openaiModel || currentEnv.OPENAI_MODEL || 'gpt-4'}
OPENAI_API_KEY=${newSettings.openaiApiKey || currentEnv.OPENAI_API_KEY || ''}

# Elevenlabs
ELEVEN_LABS_API_KEY=${newSettings.elevenLabsApiKey || currentEnv.ELEVEN_LABS_API_KEY || ''}
ELEVEN_LABS_VOICE_ID=${newSettings.elevenLabsVoiceId || currentEnv.ELEVEN_LABS_VOICE_ID || ''}
ELEVEN_LABS_MODEL_ID=${newSettings.elevenLabsModelId || currentEnv.ELEVEN_LABS_MODEL_ID || 'eleven_multilingual_v1'}
`;

    // Write to .env file
    await fs.writeFile('.env', envContent);

    // Update process.env variables
    process.env.OPENAI_MODEL = newSettings.openaiModel || currentEnv.OPENAI_MODEL;
    process.env.OPENAI_API_KEY = newSettings.openaiApiKey || currentEnv.OPENAI_API_KEY;
    process.env.ELEVEN_LABS_API_KEY = newSettings.elevenLabsApiKey || currentEnv.ELEVEN_LABS_API_KEY;
    process.env.ELEVEN_LABS_VOICE_ID = newSettings.elevenLabsVoiceId || currentEnv.ELEVEN_LABS_VOICE_ID;
    process.env.ELEVEN_LABS_MODEL_ID = newSettings.elevenLabsModelId || currentEnv.ELEVEN_LABS_MODEL_ID;

    // Reinitialize services
    await initializeElevenLabs();

    res.status(200).json({ 
      message: 'Settings updated successfully',
      settings: {
        openaiModel: process.env.OPENAI_MODEL,
        openaiApiKey: process.env.OPENAI_API_KEY,
        elevenLabsApiKey: process.env.ELEVEN_LABS_API_KEY,
        elevenLabsVoiceId: process.env.ELEVEN_LABS_VOICE_ID,
        elevenLabsModelId: process.env.ELEVEN_LABS_MODEL_ID
      }
    });
  } catch (error) {
    console.error('Error updating settings:', error);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

// Existing TTS endpoint with improved error handling
app.post("/tts", async (req, res) => {
  try {
    const userMessage = req.body.message;
    const defaultMessages = await sendDefaultMessages({ userMessage });
    
    if (defaultMessages) {
      res.send({ messages: defaultMessages });
      return;
    }
    
    let openAIResponse;
    try {
      openAIResponse = await openAIChain.invoke({
        question: userMessage,
        format_instructions: parser.getFormatInstructions(),
      });
      
      // Normalize the response format
      openAIResponse = normalizeOpenAIResponse(openAIResponse);
      
    } catch (error) {
      console.error('OpenAI Error:', error);
      
      // If there's an error with the parser but we have raw LLM output
      if (error.llmOutput) {
        try {
          // Try to parse the raw output
          const rawOutput = JSON.parse(error.llmOutput);
          if (Array.isArray(rawOutput)) {
            openAIResponse = { messages: rawOutput };
          } else {
            throw new Error('Invalid format after parsing raw output');
          }
        } catch (parseError) {
          console.error('Error parsing raw output:', parseError);
          openAIResponse = { messages: defaultResponse };
        }
      } else {
        openAIResponse = { messages: defaultResponse };
      }
    }

    const processedMessages = await lipSync({ messages: openAIResponse.messages });
    res.send({ messages: processedMessages });
    
  } catch (error) {
    console.error('Error:', error);
    const errorResponse = [{
      text: "I'm sorry, there seems to be an error. Could you please try again?",
      facialExpression: "sad",
      animation: "Idle"
    }];
    try {
      const processedError = await lipSync({ messages: errorResponse });
      res.send({ messages: processedError });
    } catch (e) {
      res.status(500).send({ error: 'Failed to process response' });
    }
  }
});

// Voice endpoint
app.get("/voices", async (req, res) => {
  try {
    res.send(await voice.getVoices(process.env.ELEVEN_LABS_API_KEY));
  } catch (error) {
    console.error('Error getting voices:', error);
    res.status(500).json({ error: 'Failed to get voices' });
  }
});

// Unified classroom creation — public rooms become discoverable, private rooms
// return an invite URL whose token is the only way in.
app.post('/api/rooms', (req, res) => {
  // Room creation is a privileged operation: authenticated INSTRUCTOR or
  // SUPER_ADMIN only (instructor workflows land in a later stage; STUDENT
  // and guests cannot create classrooms). hostId is the authenticated user —
  // the body's hostId field is ignored outside dev-compat mode.
  if (!DEV_UNAUTH) {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (req.user.role === 'STUDENT') {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
  }
  const { className, courseId, courseName, lectureId, language, roomType, scene } = req.body || {};
  const lectureCount = Number.parseInt(req.body?.lectureCount, 10) || null;
  const hostId = DEV_UNAUTH ? req.body?.hostId : req.user.id;
  const { room, error } = roomRegistry.create({ roomType, className, courseId, courseName, lectureId, language, hostId, scene, lectureCount });
  if (error) return res.status(400).json({ error });
  // Never log the invite token.
  console.log(`[rooms] ${room.roomType} room ${room.roomId} '${room.className}' created (lecture ${room.lectureId}, lang ${room.language})`);
  const scenePath = `/scene/${encodeURIComponent(room.scene)}?room=${room.roomId}${room.lectureId ? `&lecture=${room.lectureId}` : ''}`;
  res.status(201).json({
    roomId: room.roomId,
    roomType: room.roomType,
    hostId: room.hostId, // server-derived from the authenticated session
    courseName: room.courseName,
    lectureCount: room.lectureCount,
    joinUrl: `${scenePath}`,
    ...(room.roomType === 'private' ? { inviteUrl: `${scenePath}&invite=${room.inviteToken}` } : {}),
  });
});

// Backward-compatible private-only endpoint (delegates to the unified path).
app.post('/api/rooms/private', (req, res) => {
  if (!DEV_UNAUTH) {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (req.user.role === 'STUDENT') {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
  }
  const b = req.body || {};
  const { room, error } = roomRegistry.create({
    ...b,
    hostId: DEV_UNAUTH ? b.hostId : req.user.id,
    roomType: 'private',
    className: b.className || `${b.lectureId || 'Lecture'} (private)`,
  });
  if (error) return res.status(400).json({ error });
  console.log(`[rooms] private room ${room.roomId} created (lecture ${room.lectureId}, lang ${room.language}, scene ${room.scene})`);
  res.status(201).json({
    roomId: room.roomId,
    inviteUrl: `/scene/${encodeURIComponent(room.scene)}?room=${room.roomId}&lecture=${room.lectureId}&invite=${room.inviteToken}`,
  });
});

// ---- instructor courses ------------------------------------------------------
// Instructors own courses (name per owner is unique); classrooms reference a
// course by id. INSTRUCTOR sees own courses; SUPER_ADMIN sees all.
app.get('/api/courses', requireAuth, requireRole('INSTRUCTOR', 'SUPER_ADMIN'), async (req, res) => {
  try {
    const { rows } = req.user.role === 'SUPER_ADMIN'
      ? await getPool().query(
          `SELECT c.id, c.name, c.scene, c.created_at, u.display_name AS owner
           FROM courses c JOIN users u ON u.id = c.owner_id ORDER BY c.created_at`)
      : await getPool().query(
          `SELECT id, name, scene, created_at FROM courses
           WHERE owner_id = $1 ORDER BY created_at`, [req.user.id]);
    res.json({ courses: rows.map((c) => ({ ...c, createdAt: c.created_at })) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list courses' });
  }
});

app.post('/api/courses', requireAuth, requireRole('INSTRUCTOR', 'SUPER_ADMIN'), async (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 80);
  if (!name) return res.status(400).json({ error: 'A course name is required' });
  const scene = /^[A-Za-z0-9_-]{1,64}$/.test(req.body?.scene || '') ? req.body.scene : 'Multimedia';
  try {
    const { rows } = await getPool().query(
      `INSERT INTO courses (id, owner_id, name, scene) VALUES ($1,$2,$3,$4)
       ON CONFLICT (owner_id, name) DO UPDATE SET name = EXCLUDED.name
       RETURNING id, name, scene, created_at`,
      [randomUUID(), req.user.id, name, scene]);
    res.status(201).json({ course: rows[0] });
  } catch (err) {
    console.error('[courses] create failed:', err);
    res.status(500).json({ error: 'Failed to create course' });
  }
});

// ---- course build (durable state machine: ingest→plan→scripts→audio→ready) --

app.get('/api/courses/:id/status', requireAuth, async (req, res) => {
  try {
    if (req.user.role !== 'SUPER_ADMIN') {
      const { rows } = await getPool().query(
        `SELECT 1 FROM courses WHERE id=$1 AND owner_id=$2`, [req.params.id, req.user.id]);
      if (!rows.length) return res.status(403).json({ error: 'You do not own this course' });
    }
    res.json(await buildStatus(req.params.id));
  } catch (err) {
    res.status(500).json({ error: 'Failed to read status' });
  }
});

app.post('/api/courses/:id/build', requireAuth, requireRole('INSTRUCTOR', 'SUPER_ADMIN'), async (req, res) => {
  const courseId = req.params.id;
  const lectureCount = Math.max(1, Math.min(500, Number.parseInt(req.body?.lectureCount, 10) || 8));
  const lang = /^[a-z]{2}$/.test(req.body?.lang || '') ? req.body.lang : 'en';
  if (buildRunning(courseId)) {
    return res.status(409).json({ error: 'A build is already running for this course' });
  }
  // Ownership check (SUPER_ADMIN bypasses).
  if (req.user.role !== 'SUPER_ADMIN') {
    const { rows } = await getPool().query(
      `SELECT 1 FROM courses WHERE id=$1 AND owner_id=$2`, [courseId, req.user.id]);
    if (!rows.length) return res.status(403).json({ error: 'You do not own this course' });
  }
  // Reviewer-confirmed plan: [{idx,title,sources:[{filename,documentId,pages}],
  //   fullCoverage}] — one PDF per lecture, order/titles from the preview.
  try {
    const lecturePlan = Array.isArray(req.body?.lecturePlan) && req.body.lecturePlan.length
      ? req.body.lecturePlan.map((e, i) => ({
          idx: i + 1, title: String(e.title || `Lecture ${i + 1}`).slice(0, 190),
          objectives: [], queries: [], fullCoverage: true,
          sources: (Array.isArray(e.sources) ? e.sources : []).map((s) => ({
            filename: String(s.filename), documentId: s.documentId,
            pages: Array.isArray(s.pages) ? s.pages : [[1, 999]],
          })),
        }))
      : null;
    const buildId = await startBuild(courseId, lecturePlan?.length || lectureCount, lang, lecturePlan);
    setImmediate(() => runBuild(buildId, courseId, lecturePlan?.length || lectureCount, lang, lecturePlan));
    res.status(202).json({ ok: true, buildId, build: 'running' });
  } catch (err) {
    console.error('[course] build start failed:', err);
    res.status(500).json({ error: `Build could not start: ${err.message}` });
  }
});

// Preview the per-document lecture list BEFORE generation — deterministic
// filename-number ordering + content-derived titles + ambiguity flags. The
// reviewer edits order/titles in the modal and posts them back via
// lecturePlan on /build.
app.get('/api/courses/:id/plan-preview', requireAuth, requireRole('INSTRUCTOR', 'SUPER_ADMIN'), async (req, res) => {
  try {
    if (!(await courseOwnerOrAdmin(req, res, req.params.id))) return;
    const { rows: allDocs } = await getPool().query(
      `SELECT id AS "documentId", filename, pages, summary, title, status, error, extraction
         FROM course_documents WHERE course_id=$1 ORDER BY created_at`, [req.params.id]);
    const docs = allDocs.filter((d) => d.status === 'ready');
    const { rows: heads } = await getPool().query(
      `SELECT document_id, title FROM course_sections
        WHERE course_id=$1 AND idx=0`, [req.params.id]);
    const headByDoc = Object.fromEntries(heads.map((h) => [h.document_id, h.title]));
    for (const d of docs) d.firstHeading = headByDoc[d.documentId] && headByDoc[d.documentId] !== 'Document start'
      ? headByDoc[d.documentId] : null;
    const { lectures, ambiguousOrder } = planFromDocuments(docs);
    const failed = allDocs.filter((d) => d.status === 'failed')
      .map((d) => ({ filename: d.filename, error: d.error }));
    res.json({ lectures, ambiguousOrder, documents: allDocs.length,
      ready: docs.length, failed,
      extractions: Object.fromEntries(docs.map((d) => [d.filename, d.extraction || 'text'])) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to preview lecture plan' });
  }
});

// Retry ingestion for failed documents (e.g. a PDF that failed extraction).
// Reuses registered docs — no re-upload needed. Returns 202; the client
// re-polls plan-preview.
app.post('/api/courses/:id/reingest', requireAuth, requireRole('INSTRUCTOR', 'SUPER_ADMIN'), async (req, res) => {
  try {
    if (!(await courseOwnerOrAdmin(req, res, req.params.id))) return;
    const { rows: failed } = await getPool().query(
      `SELECT id FROM course_documents WHERE course_id=$1 AND status='failed'`, [req.params.id]);
    if (!failed.length) return res.json({ ok: true, retried: 0 });
    for (const d of failed) setImmediate(() => ingestDocument(d.id).catch(() => {}));
    res.status(202).json({ ok: true, retried: failed.length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to retry ingestion' });
  }
});

// ---- Script review stage -------------------------------------------------
// Builds stop at 'awaiting_review' after scripts are emitted. The course
// owner / SUPER_ADMIN reads drafts, edits segment text (ids + page mappings
// preserved server-side), then approves — approval atomically flips the
// build to 'audio' and bakes TTS for the exact reviewed text. Editing after
// approval marks the affected audio outdated and requires re-approval.

const courseOwnerOrAdmin = async (req, res, courseId) => {
  if (req.user.role === 'SUPER_ADMIN') return true;
  const { rows } = await getPool().query(
    `SELECT 1 FROM courses WHERE id=$1 AND owner_id=$2`, [courseId, req.user.id]);
  if (!rows.length) { res.status(403).json({ error: 'You do not own this course' }); return false; }
  return true;
};

app.get('/api/courses/:id/drafts', requireAuth, requireRole('INSTRUCTOR', 'SUPER_ADMIN'), async (req, res) => {
  try {
    if (!(await courseOwnerOrAdmin(req, res, req.params.id))) return;
    const { rows: lectures } = await getPool().query(
      `SELECT idx, lecture_id, title, status, artifacts FROM course_lectures
        WHERE course_id=$1 ORDER BY idx`, [req.params.id]);
    const drafts = [];
    for (const l of lectures) {
      const d = await loadLectureDraft(l.lecture_id);
      // Per-language reviewable translations — each keeps its canonical
      // version + outdated flag relative to the current master script.
      const langs = { en: { segments: d?.segments || [] } };
      for (const lang of TRANSLATION_LANGS) {
        const t = await loadLectureLangDraft(l.lecture_id, lang);
        if (t) langs[lang] = {
          segments: t.segments, edited: t.edited,
          basedOnVersion: t.basedOnVersion,
          outdated: (t.basedOnVersion ?? -1) !== (d?.version ?? 0),
        };
      }
      drafts.push({
        lectureId: l.lecture_id, title: d?.title || l.title, status: l.status,
        version: d?.version ?? 0,
        audioOutdated: l.artifacts?.audio_outdated === true,
        coverage: l.artifacts?.coverage || null,
        segments: d?.segments || [],
        langs,
      });
    }
    res.json({ drafts });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load drafts' });
  }
});

app.put('/api/courses/:id/drafts', requireAuth, requireRole('INSTRUCTOR', 'SUPER_ADMIN'), async (req, res) => {
  try {
    const courseId = req.params.id;
    if (!(await courseOwnerOrAdmin(req, res, courseId))) return;
    const pool = getPool();
    const { rows: [build] } = await pool.query(
      `SELECT id, status FROM course_builds WHERE course_id=$1 ORDER BY created_at DESC LIMIT 1`, [courseId]);
    if (!build || !['awaiting_review', 'ready', 'failed'].includes(build.status)) {
      return res.status(409).json({ error: 'No reviewable draft scripts for this course' });
    }
    const edits = Array.isArray(req.body?.lectures) ? req.body.lectures : [];
    const changed = [];
    const uncertain = [];
    for (const lec of edits) {
      // Shapes:
      //   {lang:'ar', fullText} — reviewed translation (ids stay aligned to
      //     canonical; count mismatch rejected)
      //   {fullText}            — whole canonical script, re-segmented +
      //     re-aligned (versions bump → all translations marked outdated)
      //   {segments:[{index,text}]} — legacy per-segment canonical edit
      const lang = lec.lang === 'en' ? null : lec.lang;
      const r = lang && typeof lec.fullText === 'string'
        ? await saveLectureLangDraft(courseId, lec.lectureId, lang, lec.fullText)
        : typeof lec.fullText === 'string'
          ? await saveLectureFullDraft(courseId, lec.lectureId, lec.fullText)
          : await saveLectureDraft(courseId, lec.lectureId, lec.segments);
      if (!r.ok) return res.status(400).json({ error: `${lec.lectureId}: ${r.error}` });
      if (r.changedIndexes.length) {
        changed.push({ lectureId: lec.lectureId, changedIndexes: r.changedIndexes,
          lang, validation: r.validation });
      } else if (r.validation) {
        // Whole-script save with no positional text change — still refresh
        // the stored validation so a bad script can't slip through.
        await pool.query(
          `UPDATE course_lectures SET artifacts = COALESCE(artifacts,'{}'::jsonb) || $3::jsonb
           WHERE course_id=$1 AND lecture_id=$2`,
          [courseId, lec.lectureId, JSON.stringify({ validation: r.validation })]);
      }
      if (r.uncertainIndexes?.length) {
        uncertain.push({ lectureId: lec.lectureId, uncertainIndexes: r.uncertainIndexes });
      }
    }
    // Changed text => affected audio is outdated (canonical edits cascade to
    // every language bucket; a lang edit invalidates only that language).
    for (const c of changed) {
      await invalidateSegmentAudio(c.lectureId, c.changedIndexes, c.lang || null);
      await pool.query(
        `UPDATE course_lectures
           SET artifacts = COALESCE(artifacts,'{}'::jsonb)
                 || $3::jsonb
         WHERE course_id=$1 AND lecture_id=$2`,
        [courseId, c.lectureId, JSON.stringify({
          audio_outdated: true, outdated_segments: c.changedIndexes,
          ...(c.validation ? { validation: c.validation } : {}) })]);
    }
    // Editing after approval reopens the review gate — audio must be
    // re-approved before it counts as current.
    if (changed.length && build.status === 'ready') {
      await pool.query(
        `UPDATE course_builds SET status='awaiting_review',
           stats=COALESCE(stats,'{}'::jsonb) || $2::jsonb, updated_at=now()
         WHERE id=$1`,
        [build.id, JSON.stringify({ audio_outdated: true })]);
    }
    res.json({ ok: true, changed, uncertain });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save draft edits' });
  }
});

// Approve canonical scripts → translation stage (atomic gate flip; a second
// click can never start a duplicate job).
app.post('/api/courses/:id/approve-scripts', requireAuth, requireRole('INSTRUCTOR', 'SUPER_ADMIN'), async (req, res) => {
  try {
    const courseId = req.params.id;
    if (!(await courseOwnerOrAdmin(req, res, courseId))) return;
    const pool = getPool();
    const { rows: bad } = await pool.query(
      `SELECT lecture_id FROM course_lectures WHERE course_id=$1
         AND (artifacts->'validation'->>'ok')::boolean IS NOT TRUE`, [courseId]);
    if (bad.length) {
      return res.status(409).json({
        error: `Cannot approve: ${bad.length} lecture(s) failed script validation` });
    }
    const { rows: [build] } = await pool.query(
      `SELECT id, status FROM course_builds WHERE course_id=$1 ORDER BY created_at DESC LIMIT 1`, [courseId]);
    if (!build) return res.status(404).json({ error: 'No build for this course' });
    const { rows: [flipped] } = await pool.query(
      `UPDATE course_builds SET status='translating', updated_at=now()
        WHERE id=$1 AND status='awaiting_review'
          AND COALESCE(stats->>'stage','scripts')='scripts'
        RETURNING id`, [build.id]);
    if (!flipped) {
      return res.status(409).json({ error: 'Scripts are not awaiting canonical review' });
    }
    setImmediate(() => runTranslationPhase(flipped.id, courseId));
    res.status(202).json({ ok: true, buildId: flipped.id, build: 'translating' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to approve scripts' });
  }
});

// Approve Scripts and Generate Audio — records the EXACT text fingerprints
// being approved, then atomically flips to 'audio'. The bake verifies the
// fingerprints again, so an edit racing approval can't publish mismatched
// audio; repeated clicks can never start a second job.
app.post('/api/courses/:id/approve-audio', requireAuth, requireRole('INSTRUCTOR', 'SUPER_ADMIN'), async (req, res) => {
  try {
    const courseId = req.params.id;
    if (!(await courseOwnerOrAdmin(req, res, courseId))) return;
    const pool = getPool();
    // All draft lectures must exist and pass validation before audio starts.
    const { rows: bad } = await pool.query(
      `SELECT lecture_id FROM course_lectures WHERE course_id=$1
         AND (artifacts->'validation'->>'ok')::boolean IS NOT TRUE`, [courseId]);
    if (bad.length) {
      return res.status(409).json({
        error: `Cannot approve: ${bad.length} lecture(s) failed script validation` });
    }
    const { rows: [build] } = await pool.query(
      `SELECT id, status, lecture_count, lang FROM course_builds WHERE course_id=$1 ORDER BY created_at DESC LIMIT 1`,
      [courseId]);
    if (!build) return res.status(404).json({ error: 'No build for this course' });
    // Instructor selects which languages get audio (default: teaching lang).
    const audioLangs = (Array.isArray(req.body?.audioLangs) && req.body.audioLangs.length
      ? req.body.audioLangs.filter((l) => l === 'en' || TRANSLATION_LANGS.includes(l))
      : [build.lang || 'en']);
    if (!audioLangs.length) audioLangs.push('en');
    // Gate: every selected language needs a current, reviewed script tied to
    // the canonical version; uncertain alignments need explicit confirmation.
    const { rows: lecs } = await pool.query(
      `SELECT lecture_id FROM course_lectures WHERE course_id=$1`, [courseId]);
    const drafts = {}, langDocs = {};
    for (const { lecture_id: lid } of lecs) {
      const d = await loadLectureDraft(lid);
      drafts[lid] = d ? { version: d.version, segments: d.segments.map((s) => ({ mapped: s.mapped })) } : null;
      langDocs[lid] = {};
      for (const lang of audioLangs) {
        if (lang === 'en') continue;
        const t = await loadLectureLangDraft(lid, lang);
        if (t) langDocs[lid][lang] = t;
      }
    }
    const gate = audioApprovalGate(drafts, langDocs, audioLangs,
      { confirmUncertain: req.body?.confirmUncertain === true });
    if (!gate.ok) {
      return res.status(409).json({ error: 'Cannot approve audio', blocked: gate.blocked });
    }
    if (gate.warnings?.length) {
      console.warn(`[course] audio approval warnings (non-blocking): ${gate.warnings.join('; ')}`);
    }
    // Fingerprint the exact text that will bake per (lecture, lang).
    const approved = {};
    for (const { lecture_id: lid } of lecs) {
      for (const lang of audioLangs) {
        const fp = await textFingerprintForBake(lid, lang);
        if (fp) approved[`${lid}@${lang}`] = fp;
      }
    }
    // Atomic transition — only ONE caller wins. 'failed' builds whose failure
    // happened after script approval (translation/audio phase) are retryable;
    // audio is skipped-per-segment, so retries reuse completed assets.
    const { rows: [flipped] } = await pool.query(
      `UPDATE course_builds SET status='audio',
         stats=COALESCE(stats,'{}'::jsonb) || $2::jsonb, updated_at=now()
        WHERE id=$1 AND (
          status='awaiting_review'
          OR (status='failed' AND stats->>'stage' IN ('translations','audio','validating'))
        ) RETURNING id`,
      [build.id, JSON.stringify({ approved, audio_langs: audioLangs })]);
    if (!flipped) {
      return res.status(409).json({
        error: build.status === 'audio' || build.status === 'validating'
          ? 'Audio generation is already running'
          : build.status === 'failed'
            ? `Build failed before script approval: ${build.stats?.error || 'unknown'} — fix and rebuild`
            : 'Scripts are not awaiting review' });
    }
    const buildId = flipped.id;
    setImmediate(() => runAudioPhase(buildId, courseId, build.lecture_count));
    res.status(202).json({ ok: true, buildId, build: 'audio' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to approve scripts' });
  }
});

// My classrooms — the caller's own rooms. SUPER_ADMIN sees everyone's.
// inviteToken is safe to return here: only the host (or admin) gets it.
app.get('/api/rooms/mine', requireAuth, requireRole('INSTRUCTOR', 'SUPER_ADMIN'), (req, res) => {
  const rooms = [...roomRegistry.rooms.values()]
    .filter((r) => req.user.role === 'SUPER_ADMIN' || r.hostId === req.user.id)
    .map((r) => ({
      roomId: r.roomId, roomType: r.roomType, className: r.className,
      courseId: r.courseId, courseName: r.courseName, lectureId: r.lectureId,
      language: r.language, scene: r.scene, hostId: r.hostId, createdAt: r.createdAt,
      ...(r.roomType === 'private' ? { inviteToken: r.inviteToken } : {}),
    }));
  res.json({ rooms });
});

// Gallery listing — safe public metadata only (no inviteToken/internals).
app.get('/api/rooms/public', (_req, res) => {
  res.json({ rooms: roomRegistry.listPublic() });
});

// Course materials upload — instructors attach PDFs to their room so the
// course can be built from them later (RAG pipeline). Host-only.
const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SERVER_DIR, '..', '..');
const MATERIALS_DIR = path.join(SERVER_DIR, 'uploads', 'materials');
const PDF_MAX = 25 * 1024 * 1024;
const FILES_MAX = 8;

app.post('/api/rooms/:roomId/materials', requireAuth, requireRole('INSTRUCTOR', 'SUPER_ADMIN'), async (req, res) => {
  const room = roomRegistry.get(req.params.roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.hostId !== req.user.id && req.user.role !== 'SUPER_ADMIN') {
    return res.status(403).json({ error: 'Only the classroom host can upload materials.' });
  }
  const files = req.body?.files;
  if (!Array.isArray(files) || !files.length || files.length > FILES_MAX) {
    return res.status(400).json({ error: `files must be 1–${FILES_MAX} PDF uploads` });
  }
  try {
    const dir = path.join(MATERIALS_DIR, room.roomId);
    await fs.mkdir(dir, { recursive: true });
    const saved = [];
    for (const f of files) {
      const m = /^data:(application\/pdf);base64,(.+)$/i.exec(f?.dataUrl || '');
      if (!m) return res.status(400).json({ error: 'Only PDF uploads are supported.' });
      const buf = Buffer.from(m[2], 'base64');
      if (!buf.length || buf.length > PDF_MAX) return res.status(400).json({ error: 'Each PDF must be ≤ 25 MB.' });
      const name = String(f.name || 'document.pdf').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
      await fs.writeFile(path.join(dir, name), buf);
      saved.push(name);
      // Register as a course document and kick async ingestion when the room
      // is bound to a real course (courseId = courses.id uuid).
      if (dbAvailable() && room.courseId && /^[0-9a-f-]{36}$/i.test(room.courseId)) {
        try {
          const { doc, duplicate } = await registerDocument({
            courseId: room.courseId, roomId: room.roomId, filename: name, buf, userId: req.user.id });
          if (!duplicate) setImmediate(() => ingestDocument(doc.id));
        } catch (e) { console.error('[course] document registration failed:', e.message); }
      }
    }
    console.log(`[rooms] ${saved.length} PDF(s) uploaded for ${room.roomId} by ${req.user.email}`);
    res.status(201).json({ ok: true, files: saved });
  } catch (err) {
    res.status(500).json({ error: 'Upload failed' });
  }
});

app.get('/api/rooms/:roomId/materials', requireAuth, async (req, res) => {
  const room = roomRegistry.get(req.params.roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  const files = await fs.readdir(path.join(MATERIALS_DIR, room.roomId)).catch(() => []);
  res.json({ files: files.filter((f) => f.endsWith('.pdf')) });
});

// Room meta for clients that followed an invite link — the registry scene is
// authoritative, so a link built with a bad/fallback scene can't drop guests
// into a different classroom model. Safe fields only (never inviteToken).
// Public: generated lectures for a course resolved by NAME (normalized —
// "MachineLearning" matches "Machine learning"). Lets the gallery's course
// cards show generated lectures when a built course exists; otherwise the
// caller falls back to the static scene lecture list.
app.get('/api/courses/by-name/:name/lectures', async (req, res) => {
  try {
    const norm = decodeURIComponent(req.params.name)
      .replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase();
    const { rows: [course] } = await getPool().query(
      `SELECT id, name FROM courses WHERE lower(name)=$1 ORDER BY created_at DESC LIMIT 1`, [norm]);
    if (!course) return res.json({ course: null, lectures: [] });
    const { rows } = await getPool().query(
      `SELECT lecture_id, title FROM course_lectures WHERE course_id=$1 AND status='ready' ORDER BY idx`,
      [course.id]);
    if (!rows.length) return res.json({ course: null, lectures: [] });
    res.json({ course: { course_id: course.id, title: course.name },
      lectures: rows.map(({ lecture_id, title }) => ({ lecture_id, title })) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load lectures' });
  }
});

// Generated lectures for a persistent course — used by the lecture picker when
// a room is bound to a built course (keeps static /api/lectures untouched).
app.get('/api/courses/:id/lectures', async (req, res) => {
  try {
    const pool = getPool();
    const { rows: [course] } = await pool.query(`SELECT name FROM courses WHERE id=$1`, [req.params.id]);
    const { rows } = await pool.query(
      `SELECT lecture_id, title FROM course_lectures WHERE course_id=$1 AND status='ready' ORDER BY idx`,
      [req.params.id]);
    res.json({ course: { course_id: req.params.id, title: course?.name || 'Course' }, lectures: rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load lectures' });
  }
});

// Classroom visibility — the owner/instructor flips private↔public;
// SUPER_ADMIN flips any. Persists in classrooms; takes effect immediately
// for discovery (listPublic) and admission (admit/authorize).
app.patch('/api/rooms/:roomId/visibility', requireAuth, requireRole('INSTRUCTOR', 'SUPER_ADMIN'), (req, res) => {
  const { visibility } = req.body || {};
  if (visibility !== 'public' && visibility !== 'private') {
    return res.status(400).json({ error: "visibility must be 'public' or 'private'" });
  }
  const r = roomRegistry.setVisibility(req.params.roomId, visibility,
    req.user.id, req.user.role === 'SUPER_ADMIN');
  if (!r.ok) return res.status(r.status || 403).json({ error: r.error });
  res.json({ ok: true, roomType: r.room.roomType,
    ...(r.room.roomType === 'private' ? { inviteToken: r.room.inviteToken } : {}) });
});

// Delete a classroom — ONLY: SUPER_ADMIN (any room), or an INSTRUCTOR
// deleting their own PRIVATE room. Instructors cannot delete public rooms;
// STUDENT/guest never reach this endpoint (requireRole above).
app.delete('/api/rooms/:roomId', requireAuth, requireRole('INSTRUCTOR', 'SUPER_ADMIN'), (req, res) => {
  const room = roomRegistry.get(req.params.roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  const isPrivate = room.roomType === 'private';
  const allowed = req.user.role === 'SUPER_ADMIN'
    || (isPrivate && room.hostId === req.user.id);
  if (!allowed) {
    return res.status(403).json({ error: isPrivate
      ? 'You can only delete your own private classrooms'
      : 'Only the super admin can delete classrooms' });
  }
  roomRegistry.remove(room.roomId);
  console.log(`[rooms] ${room.roomId} deleted by ${req.user.email} (${req.user.role})`);
  res.json({ ok: true });
});

// Delete a whole course — owner or SUPER_ADMIN. Cascades to documents, chunks,
// sections, plans, lecture rows; removes lecture files + audio cache + uploads.
app.delete('/api/courses/:id', requireAuth, requireRole('INSTRUCTOR', 'SUPER_ADMIN'), async (req, res) => {
  try {
    const pool = getPool();
    const { rows: [course] } = await pool.query(`SELECT owner_id, name FROM courses WHERE id=$1`, [req.params.id]);
    if (!course) return res.status(404).json({ error: 'Course not found' });
    if (req.user.role !== 'SUPER_ADMIN' && course.owner_id !== req.user.id) {
      return res.status(403).json({ error: 'You can only delete your own courses' });
    }
    const { rows: lecs } = await pool.query(`SELECT lecture_id FROM course_lectures WHERE course_id=$1`, [req.params.id]);
    const { rows: docs } = await pool.query(`SELECT room_id, filename FROM course_documents WHERE course_id=$1`, [req.params.id]);
    // End live classrooms bound to this course so they disappear everywhere.
    for (const [rid, room] of roomRegistry.rooms) {
      if (room.courseId === req.params.id) roomRegistry.remove(rid);
    }
    await pool.query(`DELETE FROM courses WHERE id=$1`, [req.params.id]);
    for (const l of lecs) {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(l.lecture_id)) continue;
      await fs.rm(path.join(REPO_ROOT, 'profbrain', 'lectures', l.lecture_id), { recursive: true, force: true });
      await fs.rm(path.join(REPO_ROOT, 'src', 'nexora_ai', 'lecture_cache', 'segments', l.lecture_id), { recursive: true, force: true });
    }
    for (const d of docs) {
      if (!/^[A-Za-z0-9_.-]+$/.test(d.filename)) continue;
      await fs.rm(path.join(MATERIALS_DIR, d.room_id, d.filename), { force: true }).catch(() => {});
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete course' });
  }
});

// Delete a generated lecture — course owner or SUPER_ADMIN. Removes the DB row
// and the on-disk profbrain + audio-cache artifacts.
app.delete('/api/courses/:id/lectures/:lectureId', requireAuth, requireRole('INSTRUCTOR', 'SUPER_ADMIN'), async (req, res) => {
  try {
    const pool = getPool();
    const { rows: [course] } = await pool.query(`SELECT owner_id FROM courses WHERE id=$1`, [req.params.id]);
    if (!course) return res.status(404).json({ error: 'Course not found' });
    if (req.user.role !== 'SUPER_ADMIN' && course.owner_id !== req.user.id) {
      return res.status(403).json({ error: 'You can only delete lectures from your own courses' });
    }
    const lid = req.params.lectureId;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(lid)) return res.status(400).json({ error: 'Invalid lecture id' });
    const { rowCount } = await pool.query(
      `DELETE FROM course_lectures WHERE course_id=$1 AND lecture_id=$2`, [req.params.id, lid]);
    if (!rowCount) return res.status(404).json({ error: 'Lecture not found' });
    await fs.rm(path.join(REPO_ROOT, 'profbrain', 'lectures', lid), { recursive: true, force: true });
    await fs.rm(path.join(REPO_ROOT, 'src', 'nexora_ai', 'lecture_cache', 'segments', lid), { recursive: true, force: true });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete lecture' });
  }
});

// Script review — the generated narration text for the creator to read
// before approving. Owner or SUPER_ADMIN only.
app.get('/api/courses/:id/lectures/:lectureId/script', requireAuth, requireRole('INSTRUCTOR', 'SUPER_ADMIN'), async (req, res) => {
  try {
    const pool = getPool();
    const { rows: [lec] } = await pool.query(
      `SELECT cl.title, cl.status, c.owner_id, cl.artifacts
         FROM course_lectures cl JOIN courses c ON c.id = cl.course_id
        WHERE cl.course_id=$1 AND cl.lecture_id=$2`, [req.params.id, req.params.lectureId]);
    if (!lec) return res.status(404).json({ error: 'Lecture not found' });
    if (req.user.role !== 'SUPER_ADMIN' && lec.owner_id !== req.user.id) {
      return res.status(403).json({ error: 'You can only review lectures from your own courses' });
    }
    const summaryPath = path.join(REPO_ROOT, 'profbrain', 'lectures', req.params.lectureId, 'summary.json');
    const summary = JSON.parse(await fs.readFile(summaryPath, 'utf-8'));
    res.json({ title: lec.title, status: lec.status, artifacts: lec.artifacts,
      text: summary.text, wordCount: summary.word_count });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load script' });
  }
});

// Approve a draft lecture → becomes visible/playable for students.
app.post('/api/courses/:id/lectures/:lectureId/approve', requireAuth, requireRole('INSTRUCTOR', 'SUPER_ADMIN'), async (req, res) => {
  try {
    const pool = getPool();
    const { rows: [course] } = await pool.query(`SELECT owner_id FROM courses WHERE id=$1`, [req.params.id]);
    if (!course) return res.status(404).json({ error: 'Course not found' });
    if (req.user.role !== 'SUPER_ADMIN' && course.owner_id !== req.user.id) {
      return res.status(403).json({ error: 'You can only approve lectures from your own courses' });
    }
    const { rows: [lec] } = await pool.query(
      `SELECT status, artifacts FROM course_lectures WHERE course_id=$1 AND lecture_id=$2`,
      [req.params.id, req.params.lectureId]);
    if (!lec) return res.status(404).json({ error: 'Lecture not found' });
    if (lec.artifacts?.validation?.ok === false) {
      const problems = (lec.artifacts.validation.problems || []).slice(0, 3).join('; ');
      return res.status(409).json({ error: `Cannot publish: validation failed — ${problems}` });
    }
    await pool.query(
      `UPDATE course_lectures SET status='ready' WHERE course_id=$1 AND lecture_id=$2`,
      [req.params.id, req.params.lectureId]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to approve lecture' });
  }
});

app.get('/api/rooms/:roomId', (req, res) => {
  const room = roomRegistry.get(req.params.roomId);
  if (!room) return res.status(404).json({ error: 'Not found' });
  const { roomId, roomType, className, courseId, courseName, lectureId, language, scene } = room;
  res.json({ roomId, roomType, className, courseId, courseName, lectureId, language, scene });
});

// Returns the room's current invite link (stable, reusable — host approval
// gates entry). rotate:true mints a new link and kills the old one — the host
// uses that to revoke a link that spread too far. hostId must match the
// registry record (no client-supplied authority).
// V2.3: compact per-user learning-memory read API (server/debug use).
app.get('/api/learning/user_memory/:participantId/:lectureId', (req, res) => {
  // Learning history is private: only the account owner or a SUPER_ADMIN may
  // read it (instructor-scoped access lands with course ownership in a later
  // stage). Open in dev-compat / no-DB mode only.
  if (!DEV_UNAUTH && dbAvailable()) {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (req.user.id !== req.params.participantId && req.user.role !== 'SUPER_ADMIN') {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
  }
  const summary = getUserLearningSummary(userMemories, req.params.participantId, req.params.lectureId);
  res.json(summary || {
    participantId: req.params.participantId,
    lectureId: req.params.lectureId,
    topicsSeen: [], topicsMissed: [], questionCount: 0,
    clarificationTopics: [], clarificationCountByTopic: {},
    reexplainedTopics: [], recentQuestions: [],
  });
});

app.post('/api/rooms/:roomId/invite', (req, res) => {
  const room = roomRegistry.get(req.params.roomId);
  if (!room || room.roomType !== 'private') {
    return res.status(404).json({ error: 'Not found' });
  }
  // Host authority comes from the authenticated session — the body field is
  // only honored under dev-compat.
  const callerId = DEV_UNAUTH ? req.body?.hostId : req.user?.id;
  if (!callerId || room.hostId !== callerId) {
    return res.status(403).json({ error: 'Only the host can generate invite links' });
  }
  const rot = req.body?.rotate === true
    ? roomRegistry.rotateInvite(req.params.roomId, callerId)
    : { ok: true, room };
  if (!rot.ok) return res.status(403).json({ error: 'Only the host can generate invite links' });
  res.json({
    inviteUrl: `/scene/${encodeURIComponent(room.scene)}?room=${room.roomId}&lecture=${room.lectureId}&invite=${rot.room.inviteToken}`,
  });
});

app.use('/api', lectureRouter);

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: CORS_ORIGINS,
    methods: ['GET', 'POST'],
    credentials: true,
  }
});
// Handshake auth: attaches socket.data.user from the session cookie.
// Unauthenticated sockets connect as guests — event gates decide the rest.
socketAuth(io);

const rooms = {}; // roomId -> { [participantId]: player }
const socketCtx = new Map(); // socketId -> { roomId, participantId }
const ncipRooms = {};
// V2.3 per-user learning memory — RAM-authoritative, async Postgres write-
// behind. Server-level (not room-scoped): survives reconnect AND room teardown.
const userMemories = createUserMemoryStore();

// Lazily hydrate a user's persisted history on first touch (fire-and-forget —
// hydration merges idempotently and never blocks the lecture path).
function ensureUserLoaded(participantId) {
  const m = userMemories.get(participantId);
  if (!m || m.__hydrated || !dbAvailable()) return;
  m.__hydrated = true;
  persist((p) => hydrateUserMemory(userMemories, participantId,
    (pid) => queries.loadUser(p, pid)));
}
// Room registry (public + private classroom metadata). Separate from NcipRoom:
// registry entries carry the secret inviteToken, NcipRoom carries protocol
// state and is what session.snapshot projects — tokens never leak into it.
const roomRegistry = new RoomRegistry();
// NCIP Slice 4: reconnect grace timers, keyed `${roomId} ${pid}`.
const graceTimers = new Map();
// NCIP Slice 5: floor timeouts, keyed `${roomId} ${pid}` — armed at
// floor-ready, disarmed when the holder's question enters THINKING.
const floorTimers = new Map();
// THINKING generation timeouts, keyed `${roomId} ${token}` — one active
// generation per room; token-verified so stale timers/results are no-ops.
const thinkingTimers = new Map();
// Answer-completion timers per room — cleared on room teardown.
const roomTimers = {};
// Microphone authorization, roomId -> Map(pid -> 'pending'|'granted').
// Runtime-only by design: permission is a live-session grant, cleared on
// leave/expiry and at room teardown — not durable state.
const micPerms = new Map();

function getNcipRoom(roomId) {
  if (!ncipRooms[roomId]) ncipRooms[roomId] = new NcipRoom(roomId);
  return ncipRooms[roomId];
}

// pid -> live socketId for targeted emits (e.to is a participantId).
function socketFor(roomId, pid) {
  return ncipRooms[roomId]?.session.participants.get(pid)?.socketId || pid;
}

function trackRoomTimer(roomId, timer) {
  (roomTimers[roomId] ??= new Set()).add(timer);
}

// Remove a participant's presence and run room teardown when empty.
function cleanupAfterRemoval(roomId, pid) {
  if (rooms[roomId]) {
    delete rooms[roomId][pid];
    io.to(roomId).emit('user-left', { userId: pid });
  }
  // Mic permission dies with presence — rejoining re-requests.
  if (micPerms.get(roomId)?.delete(pid)) emitMicState(roomId);
  if (rooms[roomId] && Object.keys(rooms[roomId]).length === 0) {
    delete rooms[roomId];
    delete ncipRooms[roomId];
    // Emptying a room must NOT destroy it: classrooms persist in the
    // registry (public cards stay listed, private invite links keep
    // working). Only an explicit DELETE — SUPER_ADMIN for any room, or an
    // INSTRUCTOR for their own private room — removes a classroom.
    for (const t of roomTimers[roomId] || []) clearTimeout(t);
    delete roomTimers[roomId];
    for (const [key, t] of graceTimers) {
      if (key.startsWith(`${roomId} `)) { clearTimeout(t); graceTimers.delete(key); }
    }
    for (const [key, t] of floorTimers) {
      if (key.startsWith(`${roomId} `)) { clearTimeout(t); floorTimers.delete(key); }
    }
    for (const [key, t] of thinkingTimers) {
      if (key.startsWith(`${roomId} `)) { clearTimeout(t); thinkingTimers.delete(key); }
    }
    micPerms.delete(roomId);
  }
}

// ---- V2 ProfessorAgent orchestration --------------------------------------
//
// Server-driven lecture progression. The agent decides the next lecture unit;
// this code is the ONLY executor — it validates the action, updates NCIP
// progress/playback, and emits a single professor-speak message to the room.
// ncip.lectureRun = { lectureId, manifest, plan } — runtime only, never
// projected into snapshots (manifest is large; snapshot carries progress).

// (Re)load the run's manifest in the room's CURRENT language — called after
// an accepted language.change so the next emitted segment is in the new
// language. The segment index space is identical across languages.
async function refreshLectureManifest(roomId) {
  const ncip = ncipRooms[roomId];
  const run = ncip?.lectureRun;
  if (!run) return;
  try {
    const lang = ncip.language.roomLanguage;
    const manifest = await loadLectureManifest(run.lectureId, lang);
    // The room may have ended/restarted while the fetch was in flight — only
    // swap when the same run is still active.
    if (ncipRooms[roomId]?.lectureRun === run) run.manifest = manifest;
  } catch (err) {
    console.error(`[agent] manifest refresh failed for ${run.lectureId} in '${roomId}':`, err);
  }
}

async function startLectureRun(roomId, lectureId) {
  const ncip = getNcipRoom(roomId);
  const manifest = await loadLectureManifest(lectureId, ncip.language.roomLanguage);
  let plan = null;
  try {
    plan = getLecturePlan(lectureId);
  } catch (err) {
    // A malformed plan is logged loudly but must not block the lecture — the
    // agent falls back to manifest order with topicId null.
    console.error(`[agent] lecture plan for ${lectureId} unusable:`, err.message);
  }
  ncip.lectureRun = { lectureId, manifest, plan, dynSeq: 0, currentUnit: null, generating: false, completedIds: new Set() };
  // Agent-driven room marker: once a V2 run has started, client-relayed
  // lecture messages are position reports only — never rebroadcast speech.
  ncip.agentRoom = true;
  // V2.3: fresh session memory per lecture run — restarts reset it; it
  // survives pause/resume/Q&A and dies with the room. Every run gets a uuid
  // so user learning histories keep Run A and Run B separate.
  const runId = randomUUID();
  ncip.lectureRun.runId = runId;
  for (const [pid, sess] of ncip.session.participants) {
    if (sess.connected) {
      ensureUserLoaded(pid);
      recordLectureJoin(userMemories, pid, lectureId, runId);
    }
  }
  ncip.professorMemory = createProfessorMemory(lectureId);
  applyEffects(roomId, ncip.startLecture(lectureId));
  // Tell every client to drop leftover units from any previous playthrough —
  // a restart (or mid-lecture re-start) must not stack the new sequence on
  // top of stale queued messages.
  io.to(roomId).emit('lecture-started', { lectureId, stateVersion: ncip.stateVersion });
  emitNextLectureUnit(roomId).catch((err) =>
    console.error(`[agent] ${roomId}: start progression error:`, err));
}

// V2.2: after a floor answer commits, record the question interaction and
// classify whether it signals confusion (background — a slow/failed classifier
// simply means no re-explanation, never a stalled lecture).
async function maybeRecordClarification(roomId, question, answerText, participantId) {
  const ncip = ncipRooms[roomId];
  const run = ncip?.lectureRun;
  if (!ncip || !run) return;
  const p = ncip.lectureProgress;
  const topicId = p.currentTopicId;
  const segmentId = p.currentSegmentId;
  const segText = run.manifest?.segments.find((s) => s.id === segmentId)?.text || '';
  const topicTitle = run.plan?.topics.find((t) => t.id === topicId)?.title || null;
  const cls = await classifyClarification({ question, topicTitle, segmentText: segText });
  const live = ncipRooms[roomId];
  if (!live || live !== ncip) return; // room died mid-classify
  const flagged = cls.needsReexamination === true || cls.needsReexplanation === true;
  live.recordInteraction({
    type: 'question', participantId, topicId, segmentId, question,
    needsReexplanation: flagged,
  });
  // Per-user learning memory: only committed answers are stored.
  if (live.lectureRun?.runId) {
    recordUserQuestion(userMemories, participantId, live.lectureRun.lectureId, live.lectureRun.runId,
      { topicId, segmentId, question, answer: answerText });
    if (flagged) {
      recordUserClarification(userMemories, participantId, live.lectureRun.lectureId, live.lectureRun.runId, topicId);
    }
  }
  // Memory: store the answered question; bump the per-topic clarification
  // counter when the classifier flagged confusion (decide() reads it).
  if (live.professorMemory) {
    recordQuestion(live.professorMemory, {
      participantId, topicId, segmentId, question, answer: answerText,
    });
    if (flagged) incrementClarification(live.professorMemory, topicId);
    console.log(`[PROF MEMORY] ${roomId}: question_answered topic=${topicId} clarifications=${live.professorMemory.clarificationCountByTopic[topicId] || 0}`,
      JSON.stringify(getProfessorMemorySummary(live.professorMemory)));
  }
  console.log(`[agent] ${roomId}: question recorded on topic=${topicId} needsReexplanation=${cls.needsReexamination ?? cls.needsReexplanation}`);
}

const UTTERANCE_FALLBACK = {
  opening: 'continue',        // -> proceed to prepared segment 0
  transition: 'continue',     // -> proceed to next prepared segment
  reexplain: 'continue',      // -> continue lecture
  closing_recap: 'end',       // -> end_lecture
};

// Decide -> validate -> execute ONE lecture unit. Async: dynamic utterances
// generate through Ollama+VoxCPM before emit. run.generating + run.currentUnit
// serialize the loop — a completion report can only advance the unit whose id
// is currently in flight, so concurrent reports never double-advance.
async function emitNextLectureUnit(roomId) {
  const ncip = ncipRooms[roomId];
  const run = ncip?.lectureRun;
  if (!run || run.generating) return;
  run.generating = true;
  try {
    // The loop only iterates on a dynamic-utterance fallback — each failure
    // marks the action applied (applyLectureAction) so decide() can't repeat it.
    for (;;) {
      const action = professorDecide({
        plan: run.plan,
        progress: ncip.lectureProgress,
        memory: ncip.professorMemory,
        userMemories,
        manifest: run.manifest,
        roomLanguage: ncip.language.roomLanguage,
        roomType: ncip.roomType,
        groupRecapMinUsers: Number(process.env.NXR_GROUP_RECAP_MIN_USERS || 2),
      });
      const check = validateAction(action, { plan: run.plan, manifest: run.manifest });
      if (!check.ok) {
        console.error(`[agent] ${roomId}: invalid action rejected:`, check.error, action);
        finishLecture(roomId, 'invalid_action');
        return;
      }
      console.log(`[agent] ${roomId}: ${action.action} seg=${action.segmentId ?? '-'} purpose=${action.purpose ?? '-'} topic=${action.topicId ?? '-'} (${action.reason}) pendingLateJoiners=${ncip.lectureProgress.groupRecap?.pendingLateJoiners?.length ?? 0}`);

      if (action.action === 'end_lecture') {
        finishLecture(roomId, 'lecture_complete');
        return;
      }

      if (action.action === 'speak_segment') {
        const seg = run.manifest.segments.find((s) => s.id === action.segmentId);
        if (!seg) { finishLecture(roomId, 'error'); return; }
        ncip.applyLectureAction(action);
        // Memory: a topic is "taught" when its last prepared segment is emitted.
        const topic = action.topicId && run.plan?.topics.find((t) => t.id === action.topicId);
        // Attendance: the FIRST segment of a topic starts it — every currently
        // connected participant "saw" this topic.
        if (topic && topic.segmentIds[0] === action.segmentId) {
          for (const [pid, sess] of ncip.session.participants) {
            if (sess.connected) recordTopicSeen(userMemories, pid, run.lectureId, run.runId, topic.id);
          }
        }
        if (topic && topic.segmentIds[topic.segmentIds.length - 1] === action.segmentId) {
          recordTopicTaught(ncip.professorMemory, topic.id);
          console.log(`[PROF MEMORY] ${roomId}: topic_taught ${topic.id}`,
            JSON.stringify(getProfessorMemorySummary(ncip.professorMemory)));
        }
        const unitId = `${run.lectureId}_seg_${seg.id}`;
        run.currentUnit = { id: unitId, kind: 'segment', segmentIndex: action.segmentId, action };
        applyEffects(roomId, ncip.updatePlayback('agent', {
          lectureId: run.lectureId,
          segmentIndex: action.segmentId,
          playbackOffsetMs: 0,
        }));
        io.to(roomId).emit('professor-speak', {
          id: unitId,
          type: 'lecture',
          unitStartedAt: Date.now(),
          lectureId: run.lectureId,
          runId: run.runId,
          title: run.manifest.title,
          text: seg.text,
          audioUrl: seg.audioUrl,
          animation: seg.animation,
          facialExpression: seg.facialExpression,
          lipsync: seg.lipsync,
          // Segment-level provenance wins over the topic's first page — the
          // board must follow THIS segment's page/document.
          slidePage: seg.slidePage ?? action.slidePage ?? null,
          slideDoc: seg.slideDoc ?? null,
          stateVersion: ncip.stateVersion,
        });
        return;
      }

      // speak_dynamic — flags committed BEFORE generation so a failure falls
      // forward instead of retry-looping the same utterance.
      // NXR_AGENT_DYNAMIC=0 disables dynamics entirely (pure prepared segments)
      // — useful for A/B debugging "script vs. spoken" differences.
      if (process.env.NXR_AGENT_DYNAMIC === '0') {
        ncip.applyLectureAction(action);
        // Dynamics disabled -> the group recap can never play; resolve the
        // pending joiners so decide() doesn't return it forever.
        if (action.purpose === 'group_recap') ncip.completeGroupRecap(action, { attempted: true });
        continue;
      }
      ncip.applyLectureAction(action);
      // The segment AFTER this dynamic — the true recovery frontier. While a
      // transition/recap plays, `playback` still names the finished segment;
      // snapshots must anchor here so recovery never replays completed
      // narration. (Opening -> 0; transition/reexplain -> next seg; closing
      // -> one past the last = end of lecture.)
      const curIdx = run.manifest.segments.findIndex(
        (s) => s.id === ncip.lectureProgress.currentSegmentId);
      const nextSegIndex = curIdx < 0 ? 0 : curIdx + 1;
      const pendingId = `${run.lectureId}_dyn_pending_${++run.dynSeq}`;
      run.currentUnit = { id: pendingId, kind: 'dynamic', purpose: action.purpose, nextSegIndex, action };
      try {
        const topicTitle = run.plan?.topics.find((t) => t.id === action.topicId)?.title ?? null;
        // Utterance timeout: a hung Ollama/TTS must never leave the room in a
        // synthetic "lecturing but silent" state. Fallbacks below apply.
        const msg = await Promise.race([
          generateLectureUtterance({
            lectureId: run.lectureId,
            language: ncip.language.roomLanguage,
            purpose: action.purpose,
            topicId: action.topicId,
            topicTitle,
            sourceSegmentIds: action.sourceSegmentIds,
          }),
          new Promise((_, rej) => setTimeout(() =>
            rej(new Error(`utterance timeout (${action.purpose})`)),
            Number(process.env.NXR_UTTERANCE_TIMEOUT_MS || 45_000))),
        ]);
        if (ncipRooms[roomId]?.lectureRun !== run) return; // ended mid-generation
        const unitId = `${run.lectureId}_dyn_${run.dynSeq}`;
        run.currentUnit = { id: unitId, kind: 'dynamic', purpose: action.purpose, nextSegIndex, action };
        applyEffects(roomId, ncip.lectureUnitStarted());
        io.to(roomId).emit('professor-speak', {
          id: unitId,
          type: 'lecture',
          unitStartedAt: Date.now(),
          dynamic: action.purpose,
          lectureId: run.lectureId,
          runId: run.runId,
          title: run.manifest.title,
          text: msg.text,
          audioUrl: msg.audioUrl,
          animation: msg.animation,
          facialExpression: msg.facialExpression,
          lipsync: msg.lipsync,
          durationMs: msg.durationMs,
          slidePage: action.slidePage ?? null,
          slideDoc: run.manifest.segments.find((s) => s.id === (action.sourceSegmentIds || [])[0])?.slideDoc ?? null,
          stateVersion: ncip.stateVersion,
        });
        return;
      } catch (err) {
        console.error(`[agent] ${roomId}: ${action.purpose} generation failed (${err.message}) — falling back`);
        // Group recap: mark the attempt so pending joiners don't retry-loop.
        if (action.purpose === 'group_recap') ncip.completeGroupRecap(action, { attempted: true });
        run.currentUnit = null;
        if (UTTERANCE_FALLBACK[action.purpose] === 'end') { finishLecture(roomId, 'utterance_failed'); return; }
        continue; // re-decide: committed flags make the next action the safe path
      }
    }
  } finally {
    run.generating = false;
  }
}

function finishLecture(roomId, reason) {
  const ncip = ncipRooms[roomId];
  if (!ncip) return;
  applyEffects(roomId, ncip.endLecture(null));
  ncip.lectureRun = null;
  io.to(roomId).emit('lecture-complete', { reason, stateVersion: ncip.stateVersion });
  console.log(`[agent] ${roomId}: lecture finished (${reason})`);
}

function nameFor(roomId, userId) {
  return rooms[roomId]?.[userId]?.name || 'Unknown';
}

function buildFloorStatePayload(roomId) {
  const ncip = getNcipRoom(roomId);
  return {
    floorQueue: ncip.floor.queue.map((id) => ({ userId: id, name: nameFor(roomId, id) })),
    activeSpeaker: ncip.floor.holder
      ? { userId: ncip.floor.holder, name: nameFor(roomId, ncip.floor.holder) }
      : null,
    professorStatus: ncip.professor.status,
    checkpoint: ncip.interruption.checkpoint,
    participants: ncip.sessionParticipants(),
    stateVersion: ncip.stateVersion,
  };
}

// NCIP Slice 2: authoritative recovery snapshot. Same floor shape as
// floor-state (display names included) so clients can reuse one reducer.
function buildSnapshotPayload(roomId, pid = null) {
  const ncip = getNcipRoom(roomId);
  const s = ncip.snapshot();
  return {
    ...s,
    // V1 catch-up: per-recipient flag — true only when THIS participant has a
    // valid recap anchor for the lecture currently playing.
    canCatchUp: pid ? ncip.canCatchUp(pid) : false,
    // Registry metadata so clients know who the host is (safe fields only —
    // inviteToken never leaves the registry).
    room: roomRegistry.get(roomId)
      ? { roomId, roomType: roomRegistry.get(roomId).roomType, hostId: roomRegistry.get(roomId).hostId }
      : null,
    floor: {
      holder: s.floor.holder
        ? { userId: s.floor.holder, name: nameFor(roomId, s.floor.holder) }
        : null,
      queue: s.floor.queue.map((id) => ({ userId: id, name: nameFor(roomId, id) })),
    },
    mic: { permissions: Object.fromEntries(micPerms.get(roomId) || []) },
  };
}

// Private-room host authority — resolved server-side from the registry,
// never from a client-supplied flag.
function isRoomHost(roomId, participantId) {
  const meta = roomRegistry.get(roomId);
  return meta?.roomType === 'private' && meta.hostId === participantId;
}

function emitFloorState(roomId, target) {
  (target || io.to(roomId)).emit('floor-state', buildFloorStatePayload(roomId));
}

// Enrich effect payloads that reference users with display names.
function enrichEffectData(roomId, event, data) {
  if (!data || event !== 'lecture-control') return data;
  const enriched = { ...data };
  if (enriched.activeSpeaker?.userId) {
    enriched.activeSpeaker = { ...enriched.activeSpeaker, name: nameFor(roomId, enriched.activeSpeaker.userId) };
  }
  if (enriched.askedBy?.userId) {
    enriched.askedBy = { ...enriched.askedBy, name: nameFor(roomId, enriched.askedBy.userId) };
  }
  return enriched;
}

// Slack added to the measured answer duration so the server-side completion
// timer accounts for client buffering/playback-start latency.
const ANSWER_END_SLACK_MS = 1000;

function scheduleAnswerEnd(roomId, answerId, durationMs) {
  const ncip = ncipRooms[roomId];
  if (!ncip) return;
  // When duration is unknown, fall back to a long safety net — client
  // 'answer-ended' reports advance the protocol immediately in that case.
  const wait = (durationMs ?? 60000) + ANSWER_END_SLACK_MS;
  const timer = setTimeout(() => {
    roomTimers[roomId]?.delete(timer);
    const room = ncipRooms[roomId];
    if (!room) return;
    applyEffects(roomId, room.answerTimeExpired(answerId));
  }, wait);
  timer.unref?.();
  trackRoomTimer(roomId, timer);
}

// NCIP Slice 5: arm/disarm the 30s floor timeout keyed to a specific holder.
// The room-level floorTimeoutExpired re-verifies holder + status on fire, so
// a timer that outlives its holder is a safe no-op.
function syncFloorTimer(roomId, pid) {
  const key = `${roomId} ${pid}`;
  const existing = floorTimers.get(key);
  if (existing) { clearTimeout(existing); floorTimers.delete(key); }

  const ncip = ncipRooms[roomId];
  const d = ncip?.floorDeadline;
  if (!d) return; // question entered THINKING or floor moved on
  const remaining = Math.max(0, d.expiresAt - Date.now());
  const timer = setTimeout(() => {
    floorTimers.delete(key);
    const room = ncipRooms[roomId];
    if (!room) return;
    console.log(`[server] floor timeout expired for ${pid} in '${roomId}'`);
    applyEffects(roomId, room.floorTimeoutExpired(pid));
  }, remaining);
  timer.unref?.();
  floorTimers.set(key, timer);
}

// Arm the 60s THINKING generation timeout, bound to the question's
// generation token so a stale timer can never recover the wrong question.
function armThinkingTimer(roomId, token) {
  const key = `${roomId} ${token}`;
  const existing = thinkingTimers.get(key);
  if (existing) { clearTimeout(existing); thinkingTimers.delete(key); }
  const ncip = ncipRooms[roomId];
  const d = ncip?.thinkingDeadline;
  if (!d || d.token !== token) return;
  const timer = setTimeout(() => {
    thinkingTimers.delete(key);
    const room = ncipRooms[roomId];
    if (!room) return;
    console.log(`[server] thinking timeout expired for generation ${token} in '${roomId}'`);
    applyEffects(roomId, room.thinkingTimeoutExpired(token));
  }, Math.max(0, d.expiresAt - Date.now()));
  timer.unref?.();
  thinkingTimers.set(key, timer);
}

// Drop all pending generation timers for a room (answer started or failed).
function clearThinkingTimers(roomId) {
  for (const [key, t] of thinkingTimers) {
    if (key.startsWith(`${roomId} `)) { clearTimeout(t); thinkingTimers.delete(key); }
  }
}

function applyEffects(roomId, effects) {
  const ncip = getNcipRoom(roomId);
  for (const e of effects || []) {
    if (e.event === 'floor-state') {
      emitFloorState(roomId);
      continue;
    }
    const data = enrichEffectData(roomId, e.event, e.data);
    // Every authoritative NCIP event carries the post-transition version.
    // professor-speak additionally carries the server wall clock so clients
    // can compute their clock offset and converge on one lecture timeline.
    const payload = { ...(data || {}), stateVersion: ncip.stateVersion,
      ...(e.event === 'professor-speak' ? { unitStartedAt: Date.now() } : {}) };
    if (e.to && e.to !== 'room') {
      io.to(socketFor(roomId, e.to)).emit(e.event, payload);
    } else {
      io.to(roomId).emit(e.event, payload);
    }
  }
}

// Private joins awaiting host approval: socketId -> { data, roomId }.
// The invite token is already consumed at this point (single-use), so a
// rejected guest cannot retry the same link.
const pendingJoins = new Map();

// ---- Stage 2: authenticated vs guest identity -------------------------------
//
// A socket is "authenticated" when the handshake resolved a valid session
// (socket.data.user) — pid = users.id and the participant inherits full NCIP
// privileges subject to role checks. Everything else is a GUEST: pid is a
// server-minted gst_<uuid>, reclaimed across reconnects only by presenting
// the matching guestToken (a bearer credential the server hashes and stores).
// Client-supplied participantId is trusted only under NXR_DEV_UNAUTH_PROTOCOL.
const socketIsAuthed = (socket) => !!socket.data?.user || DEV_UNAUTH;
// Registered room participants — signed-in users AND server-minted guests who
// completed join (public: direct; private: invite + host approval). The join
// gate is the authorization boundary; this just proves membership.
const socketIsParticipant = (socket) => {
  const ctx = socketCtx.get(socket.id);
  return !!(ctx && rooms[ctx.roomId]?.[ctx.participantId]);
};
const questionRate = new Map(); // pid -> last submit timestamp (ms)
const participantError = (socket, event) =>
  socket.emit('auth-error', { event, error: 'Join the classroom first' });
const authError = (socket, event) =>
  socket.emit('auth-error', { event, error: 'Authentication required' });

async function resolveParticipantId(socket, data) {
  if (socket.data?.user) {
    return { pid: socket.data.user.id, guest: false, user: socket.data.user };
  }
  if (DEV_UNAUTH || !dbAvailable()) {
    // Legacy client-supplied identity (dev/test mode only).
    const pid = typeof data.participantId === 'string' && data.participantId.length <= 64
      ? data.participantId : socket.id;
    return { pid, guest: !DEV_UNAUTH, user: null };
  }
  if (typeof data.guestToken === 'string') {
    const pid = await resolveGuestToken(data.guestToken).catch(() => null);
    if (pid) return { pid, guest: true, user: null };
  }
  const g = await mintGuestToken();
  socket.emit('guest-session', g); // {guestToken, participantId} — client stores it
  return { pid: g.participantId, guest: true, user: null };
}

// ---- microphone permission (runtime grants) ---------------------------------

function micMap(roomId) {
  let m = micPerms.get(roomId);
  if (!m) { m = new Map(); micPerms.set(roomId, m); }
  return m;
}

function emitMicState(roomId, target) {
  (target || io.to(roomId)).emit('mic-state', {
    permissions: Object.fromEntries(micPerms.get(roomId) || []),
  });
}

function setMicPerm(roomId, pid, state) {
  const m = micMap(roomId);
  if (state == null) m.delete(pid); else m.set(pid, state);
  emitMicState(roomId);
}

// Who may grant/deny/revoke: the private-room host (registry-resolved) or an
// authenticated SUPER_ADMIN member. Public rooms have no approver yet —
// instructor classroom-ownership arrives with Stage 4+, requests stay pending.
function canModerateMic(roomId, socket, pid) {
  if (isRoomHost(roomId, pid)) return true;
  return socket.data?.user?.role === 'SUPER_ADMIN';
}

// Post-admission join path — shared by public/private joins and by host
// approval of a pending private guest. `identity` may be pre-resolved by the
// join handler (it needs the pid for host/reconnect checks before admission).
async function finishJoin(socket, data, roomId, registryRoom = null, identity = null) {
  const safeName = typeof data.name === 'string' ? data.name.trim().slice(0, 30) : '';
  if (!safeName) {
    console.log(`[server] join rejected for ${socket.id}: invalid name`);
    socket.emit('join-error', { error: 'A valid display name is required to join.' });
    return;
  }

  // Stage 2: identity is resolved server-side — authenticated session, a
  // presented guest credential, or a freshly minted guest identity.
  identity = identity || await resolveParticipantId(socket, data);
  const pid = identity.pid;

  // Same participantId on a second live socket (duplicated tab copies
  // sessionStorage): take over — the stale socket is evicted so the two
  // contexts can't fight over presence, voice peers, or floor state.
  for (const [sid, c] of socketCtx) {
    if (sid !== socket.id && c.roomId === roomId && c.participantId === pid) {
      io.to(sid).emit('session-taken-over', { roomId });
      io.sockets.sockets.get(sid)?.leave(roomId);
      socketCtx.delete(sid);
    }
  }

  socket.join(roomId);
  socketCtx.set(socket.id, { roomId, participantId: pid });

  if (!rooms[roomId]) rooms[roomId] = {};
  const isNewNcip = !ncipRooms[roomId];
  const ncip = getNcipRoom(roomId);
  if (registryRoom && isNewNcip) {
    // First admission: adopt the registry's authoritative type/language so
    // snapshots and recap answers start in the host-selected language.
    ncip.roomType = registryRoom.roomType;
    ncip.language.roomLanguage = registryRoom.language;
  }
  const joinResult = ncip.joinParticipant(pid, socket.id);

  // V2.3 user memory: hydrate on first touch; on joining an in-flight lecture,
  // record the session join and mark topics already taught as missed
  // (reconnects stay idempotent — seen/recorded topics are never re-marked).
  if (ncip.lectureRun?.runId) {
    ensureUserLoaded(pid);
    recordLectureJoin(userMemories, pid, ncip.lectureRun.lectureId, ncip.lectureRun.runId);
    for (const t of ncip.lectureProgress.taughtTopicIds) {
      recordTopicMissed(userMemories, pid, ncip.lectureRun.lectureId, ncip.lectureRun.runId, t);
    }
    // V2.4 late-join tracking (group recap): first-time joiners only —
    // reconnects are explicitly excluded. State only; never interrupts the
    // in-flight segment.
    const cur = ncip.lectureProgress.currentSegmentId;
    if (joinResult.reconnected === false && Number.isInteger(cur)) {
      const segs = ncip.lectureRun.manifest?.segments || [];
      const missed = [];
      for (let i = 0; i < cur; i++) if (segs[i]) missed.push(i);
      const ok = ncip.recordLateJoiner(pid, cur, missed);
      console.log(`[PROF MEMORY] ${roomId}: late-joiner ${pid} during seg ${cur}, missed=${JSON.stringify(missed)} recorded=${ok} pending=${ncip.lectureProgress.groupRecap.pendingLateJoiners.length}`);
    } else {
      console.log(`[PROF MEMORY] ${roomId}: join mid-lecture NOT counted (pid=${pid} reconnected=${joinResult.reconnected} currentSegmentId=${cur})`);
    }
  }

  // A reconnect during the grace window cancels the pending expiry.
  const graceKey = `${roomId} ${pid}`;
  if (graceTimers.has(graceKey)) {
    clearTimeout(graceTimers.get(graceKey));
    graceTimers.delete(graceKey);
  }

  // Spawn slots: member 1 lands exactly on the course's spawn point; each
  // later member fans out on a ring (~1.4m steps, 45° apart) so joiners don't
  // stack on one spot. Reconnects keep their previous slot.
  let position = data.position || [0, 0, 0];
  const priorMember = rooms[roomId][pid];
  if (priorMember && Array.isArray(priorMember.position)) {
    // Reconnects keep their lateral slot but NOT the recorded height — a
    // stale y (drifted state-update, floor offsets between entries) spawns
    // the avatar under the floor. Always re-anchor to the spawn height.
    position = [priorMember.position[0], position[1], priorMember.position[2]];
  } else if (!priorMember) {
    const idx = Object.keys(rooms[roomId]).length;
    if (idx > 0) {
      const angle = (idx % 8) * (Math.PI / 4) + Math.PI / 2; // start behind spawn
      const radius = 1.4 * Math.ceil(idx / 8);
      position = [
        position[0] + Math.cos(angle) * radius,
        position[1],
        position[2] + Math.sin(angle) * radius,
      ];
    }
  }

  const user = {
    userId: pid,
    roomId,
    name: safeName,
    avatar: data.avatar || '/assets/useravatar/avatars/anim_male_1.glb',
    position,
    rotation: data.rotation || [0, 0, 0],
    animation: data.animation || 'Idle',
    timestamp: Date.now()
  };

  rooms[roomId][pid] = user;
  // Tell the joiner its assigned spawn slot — its local avatar spawns here
  // so every member lands spread around the room instead of stacked.
  socket.emit('spawn-position', { position });
  const members = Object.keys(rooms[roomId]);
  console.log(`[server] join: ${pid} (${socket.id}) joined room '${roomId}' (members: ${members.length}, reconnected: ${joinResult.reconnected})`);

  socket.broadcast.to(roomId).emit('user-joined', user);
  socket.emit('room-state', Object.values(rooms[roomId]).filter((p) => p.userId !== pid));
  emitFloorState(roomId, socket);
  emitMicState(roomId, socket);
  // Slice 2+4: joiners AND reconnectors get the authoritative snapshot —
  // floor ownership/queue position survived the grace window.
  socket.emit('session.snapshot', buildSnapshotPayload(roomId, pid));
  // Stage 2: tell the joiner its server-resolved identity so the client can
  // disable guest-ineligible controls and store its participantId.
  socket.emit('self-info', {
    participantId: pid,
    guest: identity.guest,
    user: identity.user
      ? { id: identity.user.id, email: identity.user.email, displayName: identity.user.display_name, role: identity.user.role }
      : null,
  });
}

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('join', async (data) => {
    let roomId = data.roomId || 'default';
    let registryRoom = null;
    let joinIdentity = null;

    if (data.room) {
      // Registry-room join (public or private). The room must already exist —
      // never create one from a join attempt.
      const meta = roomRegistry.get(data.room);
      if (!meta) {
        socket.emit('join-error', { error: 'This classroom link is invalid or has expired.', private: true });
        return;
      }
      // Resolve identity up front: host/reconnect checks need the
      // server-authoritative pid, never the client's claimed participantId.
      const identity = joinIdentity = await resolveParticipantId(socket, data);
      if (meta.roomType === 'private' && identity.pid !== meta.hostId) {
        // A participant already admitted to this room (known to NCIP) is
        // reconnecting — invites gate NEW members only; don't burn a token.
        const known = ncipRooms[meta.roomId]?.session?.participants?.has?.(identity.pid);
        if (known) {
          registryRoom = meta;
          roomId = meta.roomId;
          finishJoin(socket, data, roomId, registryRoom, identity);
          return;
        }
        // New guest: needs a valid invite AND host approval. The link is
        // reusable — every holder's request is parked for the host to decide.
        const auth = roomRegistry.authorize(meta.roomId, data.invite);
        if (!auth.ok) {
          socket.emit('join-error', { error: auth.error, private: true });
          return;
        }
        const hostSock = socketFor(meta.roomId, meta.hostId);
        if (!hostSock) {
          socket.emit('join-error', { error: 'The host is not in the room right now. Try again later.', private: true });
          return;
        }
        pendingJoins.set(socket.id, { data, roomId: meta.roomId });
        socket.emit('join-pending', { roomId: meta.roomId });
        io.to(hostSock).emit('private-join-request', {
          roomId: meta.roomId,
          name: typeof data.name === 'string' ? data.name.trim().slice(0, 30) : 'Guest',
          socketId: socket.id,
        });
        return; // join completes on private-join-decision
      }
      registryRoom = meta;
      roomId = meta.roomId;
    } else if (roomRegistry.isPrivate(roomId)) {
      // A private roomId used via the public path (no invite) is rejected —
      // private rooms are not reachable through sceneName joining.
      socket.emit('join-error', { error: 'This room is private. An invite link is required.', private: true });
      return;
    }

    finishJoin(socket, data, roomId, registryRoom, joinIdentity);
  });

  // Host decision on a pending private-room guest. Only the room's hostId
  // (from the registry — the socket's own participant binding) may decide.
  socket.on('private-join-decision', async ({ socketId, accept } = {}) => {
    if (!socketIsAuthed(socket)) return authError(socket, 'private-join-decision');
    const ctx = socketCtx.get(socket.id);
    if (!ctx) return;
    const meta = roomRegistry.get(ctx.roomId);
    if (!meta || meta.roomType !== 'private' || meta.hostId !== ctx.participantId) return;
    const pending = pendingJoins.get(socketId);
    if (!pending || pending.roomId !== ctx.roomId) return;
    pendingJoins.delete(socketId);
    const guest = io.sockets.sockets.get(socketId);
    if (!guest) return;
    if (accept) {
      console.log(`[server] host ${ctx.participantId} approved join for '${pending.roomId}'`);
      finishJoin(guest, pending.data, pending.roomId, meta);
    } else {
      console.log(`[server] host ${ctx.participantId} declined join for '${pending.roomId}'`);
      guest.emit('join-error', { error: 'The host declined your join request.', private: true });
    }
  });

  // Host kick (private rooms only): authority is resolved server-side from the
  // registry hostId — the client flag is never trusted. The kicked participant
  // is notified, removed from presence + NCIP state, and leaves the socket room.
  socket.on('room.kick', ({ userId } = {}) => {
    if (!socketIsAuthed(socket)) return authError(socket, 'room.kick');
    const ctx = socketCtx.get(socket.id);
    if (!ctx || !rooms[ctx.roomId]?.[ctx.participantId]) return;
    const { roomId } = ctx;
    if (!isRoomHost(roomId, ctx.participantId)) return;
    if (!userId || userId === ctx.participantId) return;
    const target = rooms[roomId]?.[userId];
    if (!target) return;
    console.log(`[server] host ${ctx.participantId} kicked ${userId} from '${roomId}'`);

    const graceKey = `${roomId} ${userId}`;
    if (graceTimers.has(graceKey)) {
      clearTimeout(graceTimers.get(graceKey));
      graceTimers.delete(graceKey);
    }
    for (const [sid, c] of socketCtx) {
      if (c.roomId === roomId && c.participantId === userId) {
        io.to(sid).emit('room-kicked', { roomId });
        io.sockets.sockets.get(sid)?.leave(roomId);
        socketCtx.delete(sid);
      }
    }
    applyEffects(roomId, getNcipRoom(roomId).leave(userId));
    cleanupAfterRemoval(roomId, userId);
  });

  // Explicit intentional leave: immediate removal, no grace window.
  socket.on('leave', () => {
    const ctx = socketCtx.get(socket.id);
    if (!ctx || !rooms[ctx.roomId]?.[ctx.participantId]) return;
    const { roomId, participantId: pid } = ctx;
    console.log(`[server] leave: ${pid} left room '${roomId}'`);
    const graceKey = `${roomId} ${pid}`;
    if (graceTimers.has(graceKey)) {
      clearTimeout(graceTimers.get(graceKey));
      graceTimers.delete(graceKey);
    }
    applyEffects(roomId, getNcipRoom(roomId).leave(pid));
    cleanupAfterRemoval(roomId, pid);
  });

  // NCIP Slice 2 recovery: a client that detects a version gap (or reconnects)
  // asks for the authoritative snapshot; only room members may sync.
  // V2.4 clock sync: echo server time so each client can estimate its
  // offset vs the authoritative lecture timeline (assumes symmetric RTT).
  socket.on('time.ping', (t0) => {
    socket.emit('time.pong', { t0, now: Date.now() });
  });

  socket.on('session.sync', () => {
    const ctx = socketCtx.get(socket.id);
    if (!ctx || !rooms[ctx.roomId]?.[ctx.participantId]) return;
    socket.emit('session.snapshot', buildSnapshotPayload(ctx.roomId, ctx.participantId));
  });

  // NCIP language.change: the server owns the room language — clients request,
  // the room state machine validates and broadcasts the authoritative result.
  socket.on('language.change', ({ language } = {}) => {
    const ctx = socketCtx.get(socket.id);
    if (!ctx || !rooms[ctx.roomId]?.[ctx.participantId]) return;
    const ncip = getNcipRoom(ctx.roomId);
    const result = ncip.changeLanguage(ctx.participantId, language);
    if (!result.ok) {
      socket.emit('lecture-control', { action: 'language-error', error: result.error });
      return;
    }
    applyEffects(ctx.roomId, result.effects);
    // V2: the next agent-emitted segment must be in the new room language —
    // swap the run's manifest asynchronously (index space is unchanged).
    refreshLectureManifest(ctx.roomId);
  });

  // NCIP floor.request: dedupe; auto-grant when the floor is free, else FIFO queue.
  socket.on('request-floor', () => {
    // NCIP floor = raise-hand: registered participants only (Stage 2).
    if (!socketIsParticipant(socket)) return participantError(socket, 'request-floor');
    const ctx = socketCtx.get(socket.id);
    if (!ctx || !rooms[ctx.roomId]?.[ctx.participantId]) return;
    const ncip = getNcipRoom(ctx.roomId);
    console.log(`[server] request-floor: ${ctx.participantId} in room '${ctx.roomId}' (status: ${ncip.professor.status})`);
    applyEffects(ctx.roomId, ncip.requestFloor(ctx.participantId));
  });

  socket.on('cancel-floor-request', () => {
    if (!socketIsParticipant(socket)) return participantError(socket, 'cancel-floor-request');
    const ctx = socketCtx.get(socket.id);
    if (!ctx) return;
    console.log(`[server] cancel-floor-request: ${ctx.participantId} in room '${ctx.roomId}'`);
    applyEffects(ctx.roomId, getNcipRoom(ctx.roomId).cancelRequest(ctx.participantId));
  });

  socket.on('release-floor', () => {
    if (!socketIsParticipant(socket)) return participantError(socket, 'release-floor');
    const ctx = socketCtx.get(socket.id);
    if (!ctx) return;
    console.log(`[server] release-floor: ${ctx.participantId} in room '${ctx.roomId}'`);
    applyEffects(ctx.roomId, getNcipRoom(ctx.roomId).releaseFloor(ctx.participantId));
  });

  // Clients report their exact interrupted lecture position when the floor is
  // granted; the server stores it as the authoritative room checkpoint.
  socket.on('lecture-checkpoint', (data) => {
    if (!socketIsParticipant(socket)) return participantError(socket, 'lecture-checkpoint');
    const ctx = socketCtx.get(socket.id);
    if (!ctx || !rooms[ctx.roomId]?.[ctx.participantId]) return;
    applyEffects(ctx.roomId, getNcipRoom(ctx.roomId).submitCheckpoint(ctx.participantId, data));
    // Checkpoint accepted => floor is ready: arm the 30s question timeout.
    syncFloorTimer(ctx.roomId, ctx.participantId);
  });

  // NCIP question.submit: only the current floor holder, only while PAUSED.
  socket.on('ask-floor-question', async (data) => {
    // AI-professor questions are a registered-user interaction (Stage 2).
    if (!socketIsParticipant(socket)) return participantError(socket, 'ask-floor-question');
    const ctx = socketCtx.get(socket.id);
    if (!ctx || !rooms[ctx.roomId]?.[ctx.participantId]) return;
    const roomId = ctx.roomId;
    const pid = ctx.participantId;

    const ncip = getNcipRoom(roomId);
    // Catch Me Up is a public-classroom feature — private rooms reject it
    // outright (canCatchUp is already false for them; this is the hard gate).
    if (data?.kind === 'recap' && ncip.roomType === 'private') {
      socket.emit('floor-question-error', { error: 'Catch Me Up is not available in private rooms.' });
      return;
    }
    const question = typeof data?.question === 'string' ? data.question.trim().slice(0, 500) : '';
    if (!question) return;
    // Per-participant rate limit — guest floods can't spam the floor. One
    // submitted question per 4s; floor-holder restrictions still apply inside
    // ncip.submitQuestion.
    const qNow = Date.now();
    const qLast = questionRate.get(pid) || 0;
    if (qNow - qLast < 4000) {
      socket.emit('floor-question-error', { error: 'Slow down — one question every few seconds.' });
      return;
    }
    questionRate.set(pid, qNow);

    const result = ncip.submitQuestion(pid, question);
    if (!result.ok) {
      socket.emit('floor-question-error', { error: result.error });
      return;
    }
    applyEffects(roomId, result.effects);
    // Valid question submitted => THINKING: disarm the floor timeout and arm
    // the generation timeout bound to this question's token.
    syncFloorTimer(roomId, pid);
    const genToken = ncip.thinkingDeadline?.token;
    if (genToken) armThinkingTimer(roomId, genToken);
    const submittedAt = Date.now();

    // V1 catch-up: kind 'recap' routes to /api/recap with the requesting
    // participant's join anchor; anything else is a normal /api/ask question.
    let apiPath = '/api/ask';
    let apiBody = {
      question,
      lectureId: data.lectureId,
      language: ncip.language.roomLanguage, // answer text locked to room language
      // V2 Phase 10: ground the answer on the segment currently being taught.
      currentSegmentId: ncip.lectureProgress?.currentSegmentId ?? null,
    };
    if (data?.kind === 'recap') {
      const range = ncip.recapRange(pid);
      if (!range) {
        // No valid anchor (joined before the lecture started, or the anchor's
        // lecture ended) — fail the generation through the normal path so the
        // room recovers and resumes cleanly.
        clearThinkingTimers(roomId);
        applyEffects(roomId, ncip.answerFailed(
          pid,
          'You are already caught up — there is nothing missed to summarize.'
        ));
        return;
      }
      apiPath = '/api/recap';
      apiBody = range;
    }

    try {
      const res = await fetch(`http://localhost:${port}${apiPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(apiBody)
      });
      const json = await res.json();
      if (!res.ok || !json.messages || json.messages.length === 0) {
        throw new Error(json.error || 'Empty answer');
      }
      const msg = json.messages[0];
      // Late result: only valid while its own generation is still THINKING —
      // a post-timeout or superseded answer must never reach the room. The
      // room-object identity check also guards against room teardown mid-fetch.
      if (ncip !== ncipRooms[roomId] || !ncip.isActiveGeneration(genToken)) {
        console.log(`[server] ignoring stale answer for generation ${genToken} in '${roomId}'`);
        return;
      }
      const answerId = `floor_${roomId}_${Date.now()}`;
      const durationMs = Number.isFinite(msg.durationMs) ? msg.durationMs : null;
      // Host-relative audio URL — remote clients resolve it against the
      // backend origin they already use (API_URL on the frontend).
      applyEffects(roomId, ncip.answerReady(answerId, {
        type: 'answer',
        askedBy: pid,
        text: msg.text,
        animation: msg.animation,
        facialExpression: msg.facialExpression,
        audioUrl: msg.audioUrl || null,
        lipsync: msg.lipsync
      }, durationMs));
      if (data?.kind === 'recap') {
        // Consume the catch-up anchor only now that the recap answer is
        // committed for the room — failed/stale generations never reach this
        // and keep the pending anchor so the participant may retry. Push a
        // fresh snapshot so the requester's canCatchUp flips authoritatively.
        ncip.markRecapSatisfied(pid);
        io.to(socketFor(roomId, pid)).emit('session.snapshot', buildSnapshotPayload(roomId, pid));
      }
      clearThinkingTimers(roomId); // THINKING -> ANSWERING disarms the timeout
      console.log(`[ncip:metrics] ${roomId}: question.submit -> answer.start = ${Date.now() - submittedAt}ms`);
      scheduleAnswerEnd(roomId, answerId, durationMs);
      // V2.2: record the interaction + run the clarification classifier in the
      // background; the agent's decide() sees the flag on next advancement.
      if (data?.kind !== 'recap') {
        maybeRecordClarification(roomId, question, message?.text, ctx.participantId).catch(() => {});
      }
    } catch (err) {
      console.error('[server] ask-floor-question failed:', err);
      clearThinkingTimers(roomId);
      applyEffects(roomId, ncip.answerFailed(
        pid,
        'The professor could not answer right now. Please try again.'
      ));
    }
  });

  // NCIP answer.end: clients report when the answer audio finished playing;
  // the first report for the current answer advances the protocol.
  socket.on('answer-ended', (data) => {
    const ctx = socketCtx.get(socket.id);
    if (!ctx) return;
    applyEffects(ctx.roomId, getNcipRoom(ctx.roomId).answerEnded(data?.id));
  });

  socket.on('state-update', (data) => {
    const ctx = socketCtx.get(socket.id);
    if (!ctx || !rooms[ctx.roomId]?.[ctx.participantId]) return;

    const user = rooms[ctx.roomId][ctx.participantId];
    user.position = data.position;
    user.rotation = data.rotation;
    user.animation = data.animation;
    user.timestamp = Date.now();

    socket.broadcast.to(ctx.roomId).emit('state-update', user);
  });

  socket.on('professor-speak', (data) => {
    const ctx = socketCtx.get(socket.id);
    if (!ctx) return;
    // Private rooms: only the host's playback reports/broadcasts drive the
    // room — a guest client cannot start or steer the lecture.
    if (roomRegistry.isPrivate(ctx.roomId) && !isRoomHost(ctx.roomId, ctx.participantId)) return;
    console.log(`[server] professor-speak from ${ctx.participantId} to room ${ctx.roomId}:`, data?.text);
    // A lecture-segment head is also the authoritative live playback position
    // — record it so late joiners can recover an in-progress lecture.
    const seg = /^(.+)_seg_(\d+)$/.exec(data?.id || '');
    const ncip = getNcipRoom(ctx.roomId);
    // Agent-driven room: the SERVER emits every lecture unit itself, so a
    // client-relayed lecture message is always just an echo/position report.
    // Honor it ONLY for the current run (lectureId + runId — an explicit
    // replay mints a new runId, so delayed reports from a finished
    // playthrough can't revive it), and NEVER rebroadcast lecture units —
    // echoes reaching a completed client would re-queue and replay the tail.
    if (data?.type === 'lecture' && ncip.agentRoom) {
      if (seg && ncip.acceptsLectureReport({ lectureId: seg[1], runId: data?.runId })) {
        applyEffects(ctx.roomId, ncip.updatePlayback(ctx.participantId, {
          lectureId: seg[1],
          segmentIndex: Number(seg[2]),
          playbackOffsetMs: 0,
        }));
      }
      return;
    }
    if (data?.type === 'lecture' && seg && seg[1] !== 'none') {
      applyEffects(ctx.roomId, ncip.updatePlayback(ctx.participantId, {
        lectureId: seg[1],
        segmentIndex: Number(seg[2]),
        playbackOffsetMs: 0,
      }));
    }
    io.to(ctx.roomId).emit('professor-speak', { ...data, unitStartedAt: Date.now() });
  });

  // The lecture queue drained on a client — clear the live position so
  // snapshots don't offer a stale segment to late joiners.
  // Host lecture lifecycle (private rooms only — public rooms have no manual
  // pause/resume and guests can never reach this path).
  socket.on('lecture-control', (data) => {
    if (!socketIsParticipant(socket)) return participantError(socket, 'lecture-control');
    const ctx = socketCtx.get(socket.id);
    if (!ctx) return;
    const meta = roomRegistry.get(ctx.roomId);
    if (!meta) return;
    // End is available to the room owner in BOTH room types + SUPER_ADMIN.
    // pause/resume stay private-host-only (public behavior unchanged).
    const isOwner = meta.hostId === ctx.participantId;
    const isAdmin = socket.data?.user?.role === 'SUPER_ADMIN';
    if (data?.action === 'end') {
      if (!isOwner && !isAdmin) {
        socket.emit('lecture-control', { action: 'control-error', error: 'Only the classroom owner can end the lecture.' });
        return;
      }
    } else if (meta.roomType !== 'private' || !isRoomHost(ctx.roomId, ctx.participantId)) {
      socket.emit('lecture-control', { action: 'control-error', error: 'Only the host can control the lecture.' });
      return;
    }
    const ncip = getNcipRoom(ctx.roomId);
    let result = null;
    if (data?.action === 'pause') result = ncip.hostPause(ctx.participantId);
    else if (data?.action === 'resume') result = ncip.hostResume(ctx.participantId);
    else if (data?.action === 'end') {
      ncip.lectureRun = null;
      applyEffects(ctx.roomId, ncip.endLecture(ctx.participantId));
      // Tell every client to stop and clear its local lecture queue — unlike
      // endLecture's implicit drain path, this is an explicit host command.
      io.to(ctx.roomId).emit('lecture-control', { action: 'end' });
      return;
    } else return;
    if (result.ok) applyEffects(ctx.roomId, result.effects);
    else socket.emit('lecture-control', { action: 'control-error', error: result.error });
  });

  socket.on('lecture-ended', () => {
    if (!socketIsParticipant(socket)) return participantError(socket, 'lecture-ended');
    const ctx = socketCtx.get(socket.id);
    if (!ctx) return;
    // Private rooms: only the host may end the shared lecture — a guest's
    // local queue draining must not reset the room's position.
    if (roomRegistry.isPrivate(ctx.roomId) && !isRoomHost(ctx.roomId, ctx.participantId)) return;
    const ncip = getNcipRoom(ctx.roomId);
    ncip.lectureRun = null;
    applyEffects(ctx.roomId, ncip.endLecture(ctx.participantId));
  });

  // V2: start a server-driven lecture session. Public rooms: any member may
  // start (V1 parity — the Start Class button was never gated). Private rooms:
  // host only, resolved server-side like every other host authority check.
  socket.on('lecture.start', async (data) => {
    if (!socketIsParticipant(socket)) return participantError(socket, 'lecture.start');
    const ctx = socketCtx.get(socket.id);
    if (!ctx || !rooms[ctx.roomId]?.[ctx.participantId]) return;
    const { roomId } = ctx;
    // STUDENT accounts can never start a lecture. Public rooms: any joined
    // participant (including minted guests) may start — V1 parity. Private:
    // host only.
    if (socket.data?.user?.role === 'STUDENT') {
      socket.emit('lecture-control', { action: 'control-error', error: 'Insufficient permissions' });
      return;
    }
    if (roomRegistry.isPrivate(roomId) && !isRoomHost(roomId, ctx.participantId)) {
      socket.emit('lecture-control', { action: 'control-error', error: 'Only the host can start the lecture.' });
      return;
    }
    const lectureId = data?.lectureId;
    if (typeof lectureId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(lectureId)) return;
    const meta = roomRegistry.get(roomId);
    const ncip = getNcipRoom(roomId);
    // Start-request dedup + switch gating — simultaneous Start clicks
    // collapse into one session; a guest can't replace a live lecture.
    const startGate = ncip.acceptLectureStart(lectureId, {
      ownerOrAdmin: meta?.hostId === ctx.participantId
        || socket.data?.user?.role === 'SUPER_ADMIN',
    });
    if (!startGate.ok) return;
    try {
      await startLectureRun(roomId, lectureId);
    } catch (err) {
      console.error(`[agent] lecture start failed for ${lectureId} in '${roomId}':`, err);
      socket.emit('lecture-control', { action: 'control-error', error: 'Failed to start the lecture.' });
    }
  });

  // V2: segment completion report. Exactly-once advance: the report is only
  // honored while the room is LECTURING and names the segment currently in
  // flight — duplicates, late reports, and reports during PAUSED/THINKING/
  // ANSWERING are all safe no-ops.
  socket.on('lecture-segment-ended', (data) => {
    const ctx = socketCtx.get(socket.id);
    if (!ctx || !rooms[ctx.roomId]?.[ctx.participantId]) return;
    const { roomId } = ctx;
    const ncip = ncipRooms[roomId];
    const run = ncip?.lectureRun;
    if (!run) return;
    if (ncip.professor.status !== ProfessorStatus.LECTURING) return;
    if (data?.lectureId !== run.lectureId) return;
    // Exactly-once: the report must name the unit currently in flight —
    // works for segments ('_seg_N' ids), dynamic utterances ('_dyn_N'),
    // and legacy reports that only carry segmentId.
    const expected = run.currentUnit?.id;
    const claimed = data?.messageId
      || (Number.isInteger(Number(data?.segmentId)) ? `${run.lectureId}_seg_${Number(data.segmentId)}` : null);
    if (!expected || claimed !== expected || expected.includes('_dyn_pending_')) return;
    // Exactly-once per RUN: a completed unit id can never complete again —
    // delayed/duplicate reports are dropped, never re-advance or replay.
    if (run.completedIds?.has(claimed)) return;
    (run.completedIds ??= new Set()).add(claimed);
    // Memory: a re-explanation "completes" when its unit actually finished
    // playing — mark it now so decide() can never loop it.
    if (run.currentUnit?.action?.purpose === 'group_recap') {
      const act = run.currentUnit.action;
      ncip.completeGroupRecap(act);
      for (const pid of act.participantIds || []) {
        recordUserGroupRecap(userMemories, pid, run.lectureId, run.runId,
          { coveredSegmentIds: act.sourceSegmentIds, joinedDuringSegmentId: act.joinedDuringSegmentId });
      }
      console.log(`[PROF MEMORY] ${roomId}: group_recap given to ${JSON.stringify(act.participantIds)}`);
    }
    if (run.currentUnit?.action?.purpose === 'reexplain') {
      const act = run.currentUnit.action;
      recordReexplanation(ncip.professorMemory, act.topicId);
      // Per-user: credit the re-explanation to the participant whose flagged
      // interaction triggered it.
      const it = Number.isInteger(act.interactionIndex)
        ? ncip.lectureProgress.interactionHistory[act.interactionIndex] : null;
      if (it?.participantId) {
        recordUserReexplanation(userMemories, it.participantId, run.lectureId, run.runId, act.topicId);
      }
      console.log(`[PROF MEMORY] ${roomId}: reexplained ${act.topicId}`);
    }
    emitNextLectureUnit(roomId).catch((err) =>
      console.error(`[agent] ${roomId}: progression error:`, err));
  });

  socket.on('chat', (data) => {
    const ctx = socketCtx.get(socket.id);
    if (ctx) socket.broadcast.to(ctx.roomId).emit('chat', { from: data.name || ctx.participantId, text: data.text });
  });

  // WebRTC signaling relay for peer voice chat: forwards offers, answers and
  // ICE candidates to a specific room member. Media flows peer-to-peer; the
  // server only shuttles SDP/ICE.
  socket.on('webrtc-signal', ({ to, data }) => {
    const ctx = socketCtx.get(socket.id);
    if (!ctx || !to || !data || !rooms[ctx.roomId]?.[to]) return;
    io.to(socketFor(ctx.roomId, to)).emit('webrtc-signal', { from: ctx.participantId, data });
  });

  // ---- Stage 2: microphone permission -------------------------------------
  //
  // Runtime grant model: any member may REQUEST; only the room host (private
  // rooms) or an authenticated SUPER_ADMIN may grant/deny/revoke; the holder
  // may release at any time. State lives in micPerms (cleared on leave and
  // teardown) and is broadcast as 'mic-state'.
  // NOTE: media is peer-to-peer WebRTC — the server authoritatively tracks
  // permission and instructs clients to disable transmission, but a hostile
  // client could still send audio to already-connected peers. Hard media
  // enforcement requires an SFU (tracked as a known limitation).
  socket.on('mic.request', () => {
    const ctx = socketCtx.get(socket.id);
    if (!ctx || !rooms[ctx.roomId]?.[ctx.participantId]) return;
    const { roomId, participantId: pid } = ctx;
    if (micMap(roomId).get(pid) === 'granted') return; // already granted
    setMicPerm(roomId, pid, 'pending');
    const hostSock = roomRegistry.get(roomId)?.hostId;
    if (hostSock) {
      io.to(socketFor(roomId, hostSock)).emit('mic-request', {
        userId: pid, name: nameFor(roomId, pid), roomId,
      });
    }
    socket.emit('mic-requested', { roomId });
  });

  socket.on('mic.decision', ({ userId, grant } = {}) => {
    if (!socketIsAuthed(socket)) return authError(socket, 'mic.decision');
    const ctx = socketCtx.get(socket.id);
    if (!ctx || !rooms[ctx.roomId]?.[ctx.participantId]) return;
    const { roomId } = ctx;
    if (!canModerateMic(roomId, socket, ctx.participantId)) return;
    if (!userId || userId === ctx.participantId || !rooms[roomId]?.[userId]) return;
    setMicPerm(roomId, userId, grant === true ? 'granted' : null);
    io.to(socketFor(roomId, userId)).emit(grant === true ? 'mic-granted' : 'mic-denied', { roomId });
  });

  socket.on('mic.revoke', ({ userId } = {}) => {
    if (!socketIsAuthed(socket)) return authError(socket, 'mic.revoke');
    const ctx = socketCtx.get(socket.id);
    if (!ctx || !rooms[ctx.roomId]?.[ctx.participantId]) return;
    const { roomId } = ctx;
    if (!canModerateMic(roomId, socket, ctx.participantId)) return;
    if (!userId || userId === ctx.participantId || !rooms[roomId]?.[userId]) return;
    setMicPerm(roomId, userId, null);
    io.to(socketFor(roomId, userId)).emit('mic-revoked', { roomId });
  });

  socket.on('mic.release', () => {
    const ctx = socketCtx.get(socket.id);
    if (!ctx || !rooms[ctx.roomId]?.[ctx.participantId]) return;
    setMicPerm(ctx.roomId, ctx.participantId, null);
  });

  // NCIP Slice 4: a dropped socket does NOT remove the participant — it
  // marks them offline and opens the 10s reconnect grace window. Presence,
  // floor ownership and queue position are preserved until expiry.
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    pendingJoins.delete(socket.id); // drop any unanswered host-approval request
    const ctx = socketCtx.get(socket.id);
    socketCtx.delete(socket.id);
    if (!ctx || !rooms[ctx.roomId]?.[ctx.participantId]) return;
    const { roomId, participantId: pid } = ctx;
    const ncip = getNcipRoom(roomId);
    if (ncip.participantDisconnected(pid)) {
      console.log(`[server] disconnect: ${pid} offline in '${roomId}' — ${ncip.RECONNECT_GRACE_MS}ms grace`);
      emitFloorState(roomId); // participants list shows them offline
      const graceKey = `${roomId} ${pid}`;
      const timer = setTimeout(() => {
        graceTimers.delete(graceKey);
        const room = ncipRooms[roomId];
        if (!room) return;
        console.log(`[server] grace expired: ${pid} removed from '${roomId}'`);
        applyEffects(roomId, room.expireGrace(pid));
        cleanupAfterRemoval(roomId, pid);
      }, ncip.RECONNECT_GRACE_MS);
      timer.unref?.();
      graceTimers.set(graceKey, timer);
    } else {
      // No participant record — treat as an immediate removal.
      applyEffects(roomId, ncip.leave(pid));
      cleanupAfterRemoval(roomId, pid);
    }
  });
});

// V2.3: init Postgres — shared pool + versioned migrations. Noop when
// DATABASE_URL is unset; never blocks the lecture hot path (writes are
// queued fire-and-forget via persist()).
initDb().then(async () => {
  roomRegistry.setPool(getPool());
  await roomRegistry.hydrate(getPool());
  resumeInterrupted();
}).catch((e) => console.error('[db] init failed:', e.message));

httpServer.listen(port, '0.0.0.0', () => {
  console.log(`Professor Abed is listening on port ${port}`);
});