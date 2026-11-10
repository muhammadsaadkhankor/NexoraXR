import 'dotenv/config';
import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from 'fs/promises';
import fsp from 'fs/promises';
import { repairCourse, repairLecture, repairStatus, repairIncompleteOnBoot } from './courses/repair.mjs';
import { openAIChain, parser } from "../nexora_ai/modules/openAI.mjs";
import { lipSync } from "../nexora_ai/modules/lip-sync.mjs";
import { sendDefaultMessages, defaultResponse } from "../nexora_ai/modules/defaultMessages.mjs";
import { voice, initializeElevenLabs } from "../nexora_ai/modules/elevenLabs.mjs";
import { createServer } from "http";
import { Server } from "socket.io";
import lectureRouter, { loadLectureManifest, generateLectureUtterance, loadLectures } from "../nexora_ai/routes/lectureRoutes.mjs";
import { NcipRoom, ProfessorStatus } from "./protocol/ncipRoom.mjs";
import { readFileSync } from "node:fs";
import { wavDurationMs } from "../nexora_ai/modules/audioUtils.mjs";
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
import { registerDocument, ingestDocument, resumeInterruptedDocs } from "./courses/pipeline.mjs";
import { startBuild, runBuild, runAudioPhase, runTranslationPhase, buildRunning, buildStatus, resumeInterrupted } from "./courses/builds.mjs";
import { loadLectureDraft, saveLectureDraft, saveLectureFullDraft, saveLectureLangDraft,
         loadLectureLangDraft, invalidateSegmentAudio, textFingerprintForBake,
         audioApprovalGate, validateDraftScript, TRANSLATION_LANGS } from "./courses/drafts.mjs";
import { planFromDocuments } from "./courses/generator.mjs";
import { isAdminTopic } from "./courses/admin.mjs";
import adminRouter from "./admin/routes.mjs";
import brandingRouter from "./branding/routes.mjs";
import { attachUser, socketAuth, requireAuth, requireRole } from "./auth/sessionMiddleware.mjs";
import { resolveGuestToken, mintGuestToken } from "./auth/passwordless.mjs";
import { RoomRegistry } from "./protocol/roomRegistry.mjs";
import { isLanguageReady, lectureReadiness } from "./protocol/languageReady.mjs";
import { instrumentEvalRoom, evalInbound, evalEffect } from "./eval/evalLogger.mjs";

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

// Canonical classroom URL: /classroom/<class-name-slug>?room=<id>&lecture=<id>
// The slug is cosmetic (derived from the classroom name); the room registry —
// resolved client-side via ?room= — is authoritative for the scene.
const classroomSlug = (room) =>
  String(room.className || room.courseName || '')
    .toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || room.scene;

const classroomPath = (room) =>
  `/classroom/${encodeURIComponent(classroomSlug(room))}?room=${room.roomId}${room.lectureId ? `&lecture=${room.lectureId}` : ''}`;

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
  const scenePath = classroomPath(room);
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
    inviteUrl: `${classroomPath(room)}&invite=${room.inviteToken}`,
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
    // Case-insensitive per-owner duplicate guard — 'Machine Learning' and
    // 'machine learning' must not become two courses (the DB unique index
    // is case-sensitive, so it can't catch this alone).
    const { rows: dup } = await getPool().query(
      `SELECT id FROM courses WHERE owner_id=$1 AND lower(name)=lower($2)`,
      [req.user.id, name]);
    if (dup.length) {
      return res.status(409).json({
        error: `You already have a course named "${name}".`,
        courseId: dup[0].id });
    }
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
  // Optional per-lecture narration target (minutes) — null keeps env default.
  const minutes = Number.isFinite(+req.body?.minutes)
    ? Math.min(15, Math.max(5, +req.body.minutes)) : null;
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
    const buildId = await startBuild(courseId, lecturePlan?.length || lectureCount, lang, lecturePlan, minutes);
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
      // "Possible missing topics" lists teachable omissions only — admin
      // content (grading, group work, office hours…) is filtered here too so
      // artifacts stored before the filter existed stay clean for the UI.
      const coverage = l.artifacts?.coverage
        ? { ...l.artifacts.coverage,
            missing: (l.artifacts.coverage.missing || []).filter((m) => !isAdminTopic(m)) }
        : null;
      drafts.push({
        lectureId: l.lecture_id, title: d?.title || l.title, status: l.status,
        version: d?.version ?? 0,
        audioOutdated: l.artifacts?.audio_outdated === true,
        coverage,
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
    if (!build) {
      // Migrated/seeded courses (e.g. Multimedia) have lecture rows but no
      // build record — scripts are still editable; no generation can be in
      // flight, so only the "lectures exist" check matters.
      const { rows: [hasLec] } = await pool.query(
        `SELECT 1 FROM course_lectures WHERE course_id=$1 LIMIT 1`, [courseId]);
      if (!hasLec) {
        return res.status(409).json({ error: 'No build exists for this course yet — generate scripts first' });
      }
    } else if (['translating', 'audio', 'validating'].includes(build.status)) {
      return res.status(409).json({
        error: 'Audio generation is already in progress — wait for it to finish before editing scripts' });
    }
    if (build && !['awaiting_review', 'ready', 'failed'].includes(build.status)) {
      return res.status(409).json({
        error: `Scripts are not editable while the build is '${build.status}'` });
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
    if (changed.length && build?.status === 'ready') {
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
// A bake-sourced duration failure used to be written into
// artifacts.validation — that is an AUDIO problem, not a script problem, and
// must not block approval/retry. Filter it out of the validation gate.
const isBakeOnlyFailure = (artifacts) => {
  const problems = artifacts?.validation?.problems || [];
  return problems.length > 0 &&
    problems.every((p) => /duration .* outside .*band|segments failed|TTS service/i.test(String(p)));
};
// The stored artifacts.validation is generator-time STRICT validation — an
// advisory flag for the reviewer. A draft save re-validates with the lighter
// reviewer-facing rules (validateDraftScript), so an approved-without-edits
// script must be judged by the SAME rules here: re-validate the current
// on-disk draft rather than trusting the stale strict flag.
const scriptInvalidLectures = async (rows, pool, courseId) => {
  const bad = [];
  for (const r of rows) {
    if (r.artifacts?.validation?.ok !== false) continue;
    if (isBakeOnlyFailure(r.artifacts)) continue;
    const d = await loadLectureDraft(r.lecture_id);
    const v = validateDraftScript(d?.segments || []);
    if (v.ok) {
      await pool.query(
        `UPDATE course_lectures SET artifacts = COALESCE(artifacts,'{}'::jsonb) || $3::jsonb
         WHERE course_id=$1 AND lecture_id=$2`,
        [courseId, r.lecture_id, JSON.stringify({ validation: v })]);
    } else bad.push(r);
  }
  return bad;
};

app.post('/api/courses/:id/approve-scripts', requireAuth, requireRole('INSTRUCTOR', 'SUPER_ADMIN'), async (req, res) => {
  try {
    const courseId = req.params.id;
    if (!(await courseOwnerOrAdmin(req, res, courseId))) return;
    const pool = getPool();
    const { rows: lecRows } = await pool.query(
      `SELECT lecture_id, artifacts FROM course_lectures WHERE course_id=$1
         AND (artifacts->'validation'->>'ok')::boolean IS NOT TRUE`, [courseId]);
    const bad = await scriptInvalidLectures(lecRows, pool, courseId);
    if (bad.length) {
      return res.status(409).json({
        error: `Cannot approve: ${bad.length} lecture(s) failed script validation` });
    }
    const { rows: [build] } = await pool.query(
      `SELECT id, status FROM course_builds WHERE course_id=$1 ORDER BY created_at DESC LIMIT 1`, [courseId]);
    if (!build) return res.status(404).json({ error: 'No build for this course' });
    // Retryable: a build that failed inside the translation stage re-enters
    // here — reviewed scripts and fingerprints are preserved.
    const { rows: [flipped] } = await pool.query(
      `UPDATE course_builds SET status='translating', updated_at=now()
        WHERE id=$1 AND (
          (status='awaiting_review' AND COALESCE(stats->>'stage','scripts')='scripts')
          OR (status='failed' AND stats->>'stage' IN ('translations'))
        ) RETURNING id`, [build.id]);
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
    const { rows: lecRows } = await pool.query(
      `SELECT lecture_id, artifacts FROM course_lectures WHERE course_id=$1
         AND (artifacts->'validation'->>'ok')::boolean IS NOT TRUE`, [courseId]);
    const bad = await scriptInvalidLectures(lecRows, pool, courseId);
    if (bad.length) {
      return res.status(409).json({
        error: `Cannot approve: ${bad.length} lecture(s) failed script validation` });
    }
    const { rows: [build] } = await pool.query(
      `SELECT id, status, lecture_count, lang FROM course_builds WHERE course_id=$1 ORDER BY created_at DESC LIMIT 1`,
      [courseId]);
    if (!build) return res.status(404).json({ error: 'No build for this course' });
    // Instructor may select languages; the default is ALL supported languages
    // (en + every translation) — missing drafts are auto-prepared during the
    // audio phase, so the reviewer never has to tick them one by one.
    const audioLangs = [...new Set((Array.isArray(req.body?.audioLangs) && req.body.audioLangs.length
      ? req.body.audioLangs.filter((l) => l === 'en' || TRANSLATION_LANGS.includes(l))
      : [build.lang || 'en', ...TRANSLATION_LANGS]))];
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
      // Missing machine translations and outdated UNEDITED translations are
      // auto-fixable — runAudioPhase (re)prepares them. Only a stale
      // REVIEWED translation or a missing canonical script is a hard block.
      const hard = gate.blocked.filter((b) => {
        const m = String(b).match(/^(\S+)\/(\w+): (no script|outdated)/);
        if (!m) return true;
        return !!langDocs[m[1]]?.[m[2]]?.edited;
      });
      if (hard.length) {
        return res.status(409).json({ error: 'Cannot approve audio', blocked: hard });
      }
      console.warn(`[course] audio approval: ${gate.blocked.length} translation(s) will be auto-prepared during bake`);
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
    // happened after script approval are retryable — detected via the stage
    // marker OR the presence of approval fingerprints (covers failed builds
    // written before the stage marker existed). Audio bake is skipped per
    // already-baked segment, so retries reuse completed assets.
    const { rows: [flipped] } = await pool.query(
      `UPDATE course_builds SET status='audio',
         stats=COALESCE(stats,'{}'::jsonb) || $2::jsonb, updated_at=now()
        WHERE id=$1 AND (
          status='awaiting_review'
          OR (status='failed' AND (
            stats->>'stage' IN ('translations','audio','validating')
            OR stats ? 'approved'))
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

// Resume/backfill audio for an existing course — prepares missing translations
// and bakes only the languages requested (default: all supported). Reuses the
// approved fingerprints and the per-segment audio cache, so nothing already
// baked is re-synthesized and no scripts are regenerated. Works on
// 'awaiting_review', 'failed', and 'ready' (adds missing languages to a
// completed build).
app.post('/api/courses/:id/prepare-audio', requireAuth, requireRole('INSTRUCTOR', 'SUPER_ADMIN'), async (req, res) => {
  try {
    const courseId = req.params.id;
    if (!(await courseOwnerOrAdmin(req, res, courseId))) return;
    if (buildRunning(courseId)) {
      return res.status(409).json({ error: 'A build is already running for this course' });
    }
    const pool = getPool();
    const { rows: [build] } = await pool.query(
      `SELECT id, status, lecture_count, lang FROM course_builds WHERE course_id=$1 ORDER BY created_at DESC LIMIT 1`,
      [courseId]);
    if (!build) return res.status(404).json({ error: 'No build for this course' });
    const ALL = ['en', ...TRANSLATION_LANGS];
    const langs = [...new Set((Array.isArray(req.body?.langs) && req.body.langs.length
      ? req.body.langs : ALL).filter((l) => ALL.includes(l)))];
    if (!langs.length) return res.status(400).json({ error: 'No valid languages requested' });
    // Approved fingerprints stay untouched — runAudioPhase still verifies the
    // canonical text matches what was approved. audio_langs only extends the
    // language set; existing approved fingerprints are not cleared.
    const { rows: [flipped] } = await pool.query(
      `UPDATE course_builds SET status='audio',
         stats=COALESCE(stats,'{}'::jsonb) || $2::jsonb, updated_at=now()
        WHERE id=$1 AND status IN ('awaiting_review','ready','failed')
        RETURNING id`,
      [build.id, JSON.stringify({ audio_langs: langs })]);
    if (!flipped) {
      return res.status(409).json({ error: `Build is not resumable (status ${build.status})` });
    }
    setImmediate(() => runAudioPhase(flipped.id, courseId, build.lecture_count));
    res.status(202).json({ ok: true, buildId: flipped.id, build: 'audio', langs });
  } catch (err) {
    res.status(500).json({ error: 'Failed to start audio preparation' });
  }
});

// Per-lecture, per-language readiness — counts REAL artifacts on disk:
// a language is 'ready' only when every segment wav exists in its
// language-keyed cache bucket; 'partial' some wavs; 'translated' text-only;
// 'missing' nothing. 'preparing' reflects a running translation/audio build.
app.get('/api/courses/:id/lang-status', requireAuth, requireRole('INSTRUCTOR', 'SUPER_ADMIN'), async (req, res) => {
  try {
    const courseId = req.params.id;
    if (!(await courseOwnerOrAdmin(req, res, courseId))) return;
    const pool = getPool();
    const LANGS = ['en', ...TRANSLATION_LANGS];
    const segRoot = path.join(REPO_ROOT, 'src', 'nexora_ai', 'lecture_cache', 'segments');
    const { rows: [build] } = await pool.query(
      `SELECT status, stats FROM course_builds WHERE course_id=$1 ORDER BY created_at DESC LIMIT 1`, [courseId]);
    const preparing = ['translating', 'audio', 'validating'].includes(build?.status);
    const { rows } = await pool.query(
      `SELECT lecture_id, title, status FROM course_lectures WHERE course_id=$1 ORDER BY idx`, [courseId]);
    const lectures = [];
    for (const l of rows) {
      let nSegs = 0;
      try {
        nSegs = (JSON.parse(await fs.readFile(
          path.join(REPO_ROOT, 'profbrain', 'lectures', l.lecture_id, 'segments.json'), 'utf-8'))
          .segments || []).length;
      } catch {}
      const langs = {};
      for (const lang of LANGS) {
        const key = lang === 'en' ? l.lecture_id : `${l.lecture_id}__${lang}`;
        let wavs = 0, txts = 0;
        try {
          const files = await fs.readdir(path.join(segRoot, key));
          wavs = files.filter((f) => /^segment_\d+\.wav$/.test(f)).length;
          txts = files.filter((f) => /^segment_\d+\.txt$/.test(f)).length;
        } catch {}
        langs[lang] = !nSegs ? 'missing'
          : wavs >= nSegs ? 'ready'
          : wavs > 0 ? 'partial'
          : txts > 0 ? 'translated'
          : 'missing';
      }
      lectures.push({ lectureId: l.lecture_id, title: l.title, status: l.status, segments: nSegs, langs });
    }
    res.json({ lectures, preparing, progress: build?.stats?.progress || null, status: build?.status || null });
  } catch (err) {
    res.status(500).json({ error: 'Failed to read language status' });
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
const AI_SEGMENTS = path.resolve(SERVER_DIR, '../nexora_ai/lecture_cache/segments');
const PROFBRAIN_LECTURES = path.resolve(SERVER_DIR, '../../profbrain/lectures');
const REPO_ROOT = path.resolve(SERVER_DIR, '..', '..');

// Display names for user-facing language readiness errors.
import { LANGUAGE_NAMES, LANGUAGE_CODES } from '../shared/languages.mjs';
const LECTURE_LANG_LABELS = LANGUAGE_NAMES;
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
    // Multiple courses can share a (case-folded) name — pick deterministically:
    // the caller's own course first, then one that actually has ready
    // lectures, then newest. Never silently serve the wrong course's list.
    const { rows: [course] } = await getPool().query(
      `SELECT c.id, c.name FROM courses c
        WHERE lower(c.name)=$1
        ORDER BY
          (c.owner_id = $2) DESC,
          EXISTS (SELECT 1 FROM course_lectures l
                  WHERE l.course_id=c.id AND l.status='ready') DESC,
          c.created_at DESC
        LIMIT 1`, [norm, req.user?.id || null]);
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
    // Authoritative spoken script = segments.json (playback order — the same
    // manifest the lecture run emits to TTS). summary.json is the generator's
    // summary document and can drift after script edits/re-segmentation;
    // it's the fallback only for lectures that predate segments.json.
    const segPath = path.join(REPO_ROOT, 'profbrain', 'lectures', req.params.lectureId, 'segments.json');
    const summaryPath = path.join(REPO_ROOT, 'profbrain', 'lectures', req.params.lectureId, 'summary.json');
    let text = null;
    try {
      const segs = JSON.parse(await fs.readFile(segPath, 'utf-8')).segments;
      if (segs?.length) text = segs.map((s) => s.text).join('\n\n');
    } catch {}
    if (!text) {
      const summary = JSON.parse(await fs.readFile(summaryPath, 'utf-8'));
      text = summary.text;
    }
    res.json({ title: lec.title, status: lec.status, artifacts: lec.artifacts,
      text, wordCount: text.split(/\s+/).filter(Boolean).length });
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
    if (lec.artifacts?.validation?.ok === false && !isBakeOnlyFailure(lec.artifacts)) {
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

// Lecture-scoped join: an unbound course classroom is an entry point —
// picking a lecture resolves to ONE dedicated room per (room, lecture).
// Admission mirrors normal room entry: public rooms admit everyone,
// private rooms require a valid ?invite token (never returned here — the
// client already carries it). Idempotent: deterministic child room id.
app.post('/api/rooms/:roomId/join-lecture', (req, res) => {
  const room = roomRegistry.get(req.params.roomId);
  if (!room) return res.status(404).json({ error: 'Not found' });
  const admit = roomRegistry.admit(req.params.roomId, req.body?.invite);
  if (!admit.ok) return res.status(403).json({ error: admit.error });
  const { room: target, error } =
    roomRegistry.findOrCreateLectureRoom(req.params.roomId, req.body?.lectureId);
  if (error) return res.status(409).json({ error });
  res.json({
    roomId: target.roomId, className: target.className,
    lectureId: target.lectureId, joinUrl: classroomPath(target),
  });
});

// Public course catalogue for the landing gallery: every course that has
// at least one APPROVED (status='ready') lecture gets its own section.
// No auth — the gallery is visible to guests.
app.get('/api/courses/public', async (req, res) => {
  try {
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT c.id, c.name,
              json_agg(json_build_object('lecture_id', l.lecture_id, 'title', l.title)
                       ORDER BY l.idx) AS lectures
         FROM courses c
         JOIN course_lectures l ON l.course_id = c.id AND l.status = 'ready'
        GROUP BY c.id, c.name
        ORDER BY c.id`);
    // Approved (status='ready') is the human gate; allReady means the
    // assets are actually baked — only offer lectures that can start.
    const courses = [];
    for (const row of rows) {
      const lectures = [];
      for (const l of row.lectures) {
        const ready = await lectureReadiness(l.lecture_id).catch(() => null);
        if (ready?.allReady) lectures.push(l);
      }
      if (lectures.length) courses.push({ ...row, lectures });
    }
    res.json({ courses });
  } catch {
    res.json({ courses: [] });
  }
});

// Standalone lecture join: the landing-page lecture gallery resolves a
// lecture pick to ONE public room per lecture (pub_lecture__<id>), created
// on first join — no course classroom required. Everyone attending the
// same lecture shares it; different lectures are different classrooms.
app.post('/api/rooms/for-lecture', async (req, res) => {
  const lectureId = req.body?.lectureId;
  try {
    const data = await loadLectures();
    let title = data?.lectures?.find((l) => l.lecture_id === lectureId)?.title;
    let courseName = data?.title || null;
    if (!title) {
      // Generated-course lectures (course_lectures) — approved builds only
      // reach this far; unapproved/draft ids are rejected below by the
      // readiness gate or here when the id doesn't exist at all.
      const { rows: [row] } = await getPool().query(
        `SELECT l.title, c.name AS course_name
           FROM course_lectures l JOIN courses c ON c.id = l.course_id
          WHERE l.lecture_id = $1`, [lectureId]).catch(() => ({ rows: [] }));
      if (!row) return res.status(404).json({ error: 'Unknown lectureId' });
      title = row.title;
      courseName = row.course_name;
    }
    // Only fully-prepared lectures get a room — an unbaked lecture would
    // die at the start gate inside a dead classroom anyway.
    const ready = await lectureReadiness(lectureId).catch(() => null);
    if (!ready?.allReady) {
      return res.status(409).json({ error: 'This lecture is still being prepared.' });
    }
    const { room, error } = roomRegistry.findOrCreateStandaloneLectureRoom({
      lectureId,
      className: title,
      courseName,
      scene: 'Multimedia',
    });
    if (error) return res.status(400).json({ error });
    res.json({
      roomId: room.roomId, className: room.className,
      lectureId: room.lectureId, joinUrl: classroomPath(room),
    });
  } catch {
    res.status(500).json({ error: 'Failed to resolve lecture room' });
  }
});

// Lectures for the room's bound course. Unlike the public course endpoint
// (ready-only), joiners see every lecture — including drafts under review —
// because room admission is the gate and the host teaches from this list.
app.get('/api/rooms/:roomId/lectures', async (req, res) => {
  const room = roomRegistry.get(req.params.roomId);
  if (!room) return res.status(404).json({ error: 'Not found' });
  if (!/^[0-9a-f-]{36}$/i.test(room.courseId || '')) {
    return res.json({ course: null, lectures: [] });
  }
  try {
    const pool = getPool();
    const { rows: [course] } = await pool.query('SELECT id, name FROM courses WHERE id=$1', [room.courseId]);
    const { rows } = await pool.query(
      `SELECT lecture_id, title, status FROM course_lectures WHERE course_id=$1 ORDER BY idx`,
      [room.courseId]);
    res.json({ course: { course_id: room.courseId, title: course?.name || room.courseName || 'Course' }, lectures: rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load lectures' });
  }
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
    inviteUrl: `${classroomPath(rot.room)}&invite=${rot.room.inviteToken}`,
  });
});

// Readiness matrix for the classroom UI — the Start button and language
// menu use this so a partially-baked language is never offered. Includes
// whether a repair job is currently filling the gaps.
app.get('/api/lecture/:lectureId/readiness', async (req, res) => {
  const { lectureId } = req.params;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(lectureId || '')) {
    return res.status(400).json({ error: 'Invalid lectureId' });
  }
  try {
    const r = await lectureReadiness(lectureId);
    const job = repairStatus(lectureId);
    // A build's audio phase counts as "running" too — the panel shows
    // 'Preparing' only while real work is in flight.
    const { rows: [lec] } = await getPool().query(
      `SELECT course_id FROM course_lectures WHERE lecture_id=$1`, [lectureId])
      .catch(() => ({ rows: [null] }));
    const buildRunningNow = lec?.course_id ? buildRunning(lec.course_id) : false;
    const jobOrBuild = job || (buildRunningNow ? { build: true } : null);
    // Per-language failed-segment detail for the review screen —
    // English text + whatever translated text exists + the exact reason
    // the segment failed (translation draft 'failures' map first, then
    // duration flags / repair records from lecture artifacts).
    const { rows: [lecArt] } = await getPool().query(
      `SELECT artifacts FROM course_lectures WHERE lecture_id=$1`, [lectureId])
      .catch(() => ({ rows: [null] }));
    const durFlags = lecArt?.artifacts?.duration_flags || {};
    const repairFlags = lecArt?.artifacts?.failed_segments || [];
    const failed = [];
    const enManifest = await loadLectureManifest(lectureId, 'en').catch(() => null);
    for (const [lang, lr] of Object.entries(r.langs)) {
      if (!(lr.missingSegments || []).length) continue;
      const draft = await loadLectureLangDraft(lectureId, lang).catch(() => null);
      for (const idx of lr.missingSegments || []) {
        const enText = enManifest?.segments?.[idx]?.text || '';
        let langText = null;
        try {
          langText = await fsp.readFile(path.join(
            AI_SEGMENTS, `${lectureId}__${lang}`,
            `segment_${String(idx).padStart(3, '0')}.txt`), 'utf-8');
        } catch { /* no translation exists */ }
        const durFlag = (durFlags[lang] || []).find((f) => f.idx === idx);
        const reason = draft?.failures?.[String(idx)] || draft?.failures?.[idx]
          || (durFlag
            ? `audio duration ${durFlag.ratio}× English segment — outside 0.5–3.0 safety band (likely truncated or a TTS loop)`
            : repairFlags.find((f) => f.lang === lang && f.idx === idx)?.reason)
          || null;
        failed.push({ lang, idx, enText, langText, reason });
      }
    }
    res.json({ ...r, failed, running: !!jobOrBuild, repair: job || null });
  } catch (err) {
    res.status(500).json({ error: 'Readiness check failed', detail: String(err.message || err).slice(0, 200) });
  }
});

// Kick a repair job for one lecture — fills only missing
// segments/utterances per language. Runs in background; the readiness
// endpoint reports progress via 'running'.
app.post('/api/lecture/:lectureId/repair', requireAuth,
  requireRole('INSTRUCTOR', 'SUPER_ADMIN'), async (req, res) => {
  const { lectureId } = req.params;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(lectureId || '')) {
    return res.status(400).json({ error: 'Invalid lectureId' });
  }
  if (repairStatus(lectureId)) return res.json({ running: true });
  repairLecture(lectureId).then((r) =>
    console.log(`[repair] ${lectureId}: ${r.ready ? 'READY' : 'incomplete: ' + (r.missing || []).join('; ')}`))
    .catch((e) => console.warn(`[repair] ${lectureId} failed:`, e.message));
  res.json({ running: true });
});

// Repair a whole course — same job, course-scoped (host "Retry" button).
app.post('/api/courses/:id/repair', requireAuth, requireRole('INSTRUCTOR', 'SUPER_ADMIN'), async (req, res) => {
  const courseId = req.params.id;
  if (!(await courseOwnerOrAdmin(req, res, courseId))) return;
  if (repairStatus(courseId)) return res.json({ running: true });
  repairCourse(courseId, (p) => console.log(`[repair] ${courseId}: ${p}`))
    .then((r) => console.log(`[repair] course ${courseId} done:`,
      Object.entries(r.lectures || {}).map(([l, x]) => `${l}:${x.ready ? 'ready' : 'incomplete'}`).join(', ')))
    .catch((e) => console.warn(`[repair] course ${courseId} failed:`, e.message));
  res.json({ running: true });
});

// Instructor edit of one translated segment + immediate single-segment
// rebake — the "still fails" escape hatch: fix the text, bake just it.
app.post('/api/lecture/:lectureId/segment/:lang/:idx', requireAuth,
  requireRole('INSTRUCTOR', 'SUPER_ADMIN'), async (req, res) => {
  const { lectureId, lang, idx } = req.params;
  const { text } = req.body || {};
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(lectureId || '') ||
      !/^[a-z]{2}$/.test(lang || '') || !/^\d+$/.test(idx || '') ||
      typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'Expected lectureId, lang, idx and {text}' });
  }
  try {
    const { validateTranslation } = await import('../nexora_ai/modules/textLangCheck.mjs');
    const check = await validateTranslation(text, lang).catch(() => ({ ok: true }));
    if (check.ok === false && lang !== 'en') {
      return res.status(422).json({ error: `Text failed language validation: ${check.reason}` });
    }
    const segDir = path.join(AI_SEGMENTS, lang === 'en' ? lectureId : `${lectureId}__${lang}`);
    const base = `segment_${String(+idx).padStart(3, '0')}`;
    await fsp.mkdir(segDir, { recursive: true });
    await fsp.writeFile(path.join(segDir, `${base}.txt`), text.trim());
    await fsp.rm(path.join(segDir, `${base}.wav`), { force: true });
    // Update the reviewable translation draft too so a future re-bake keeps it.
    const { loadLectureLangDraft } = await import('./courses/drafts.mjs');
    const draft = await loadLectureLangDraft(lectureId, lang);
    if (draft?.segments) {
      const s = draft.segments.find((x) => x.id === +idx);
      if (s) {
        s.text = text.trim();
        draft.edited = true;
        await fsp.writeFile(
          path.join(PROFBRAIN_LECTURES, lectureId, 'translations', `${lang}.json`),
          JSON.stringify(draft, null, 2));
      }
    }
    const { generateSegmentAudio } = await import('../nexora_ai/routes/lectureRoutes.mjs');
    const cacheKey = lang === 'en' ? lectureId : `${lectureId}__${lang}`;
    await generateSegmentAudio(cacheKey, +idx, text.trim(), lang);
    res.json({ ok: true, readiness: await lectureReadiness(lectureId) });
  } catch (err) {
    res.status(500).json({ error: `Segment rebake failed: ${String(err.message || err).slice(0, 200)}` });
  }
});

// "Retry translation" for one failed segment — re-runs the translator on the
// English source with the STRONG model only, writes the draft + runtime
// cache text, and returns the new text for review. Audio bake stays a
// separate step (the reviewer's edit/re-bake path).
app.post('/api/lecture/:lectureId/segment/:lang/:idx/retranslate', requireAuth,
  requireRole('INSTRUCTOR', 'SUPER_ADMIN'), async (req, res) => {
  const { lectureId, lang, idx } = req.params;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(lectureId || '') ||
      !/^[a-z]{2}$/.test(lang || '') || lang === 'en' || !/^\d+$/.test(idx || '')) {
    return res.status(400).json({ error: 'Expected lectureId, non-en lang, idx' });
  }
  try {
    const { translateForLecture, loadLectureManifest } =
      await import('../nexora_ai/routes/lectureRoutes.mjs');
    const en = await loadLectureManifest(lectureId, 'en');
    const src = en?.segments?.[+idx]?.text;
    if (!src) return res.status(404).json({ error: `No English segment ${idx} for ${lectureId}` });
    const text = await translateForLecture(src, lang,
      { lectureId, segmentId: +idx, strongOnly: true });
    // Upsert the translation draft + runtime cache text; clear the recorded
    // failure so readiness stops reporting the old reason.
    const { loadLectureLangDraft, scriptFingerprint, canonicalVersion } =
      await import('./courses/drafts.mjs');
    const draft = await loadLectureLangDraft(lectureId, lang);
    const version = draft?.basedOnVersion ?? await canonicalVersion(lectureId);
    const segments = [...(draft?.segments || [])];
    const slot = segments.findIndex((s) => s.id === +idx);
    if (slot >= 0) segments[slot] = { ...segments[slot], text };
    else segments.push({ id: +idx, text });
    segments.sort((a, b) => a.id - b.id);
    const failures = { ...(draft?.failures || {}) };
    delete failures[idx]; delete failures[String(idx)];
    const payload = { ...(draft || {}), lang, lectureId,
      version: draft?.version ?? version, basedOnVersion: version,
      fingerprint: scriptFingerprint(segments), edited: draft?.edited ?? false,
      segments, ...(Object.keys(failures).length ? { failures } : { failures: {} }) };
    await fsp.mkdir(path.join(PROFBRAIN_LECTURES, lectureId, 'translations'), { recursive: true });
    await fsp.writeFile(path.join(
      PROFBRAIN_LECTURES, lectureId, 'translations', `${lang}.json`),
      JSON.stringify(payload, null, 2));
    const segDir = path.join(AI_SEGMENTS, `${lectureId}__${lang}`);
    const base = `segment_${String(+idx).padStart(3, '0')}`;
    await fsp.mkdir(segDir, { recursive: true });
    await fsp.writeFile(path.join(segDir, `${base}.txt`), text);
    await fsp.rm(path.join(segDir, `${base}.wav`), { force: true }).catch(() => {});
    await fsp.rm(path.join(segDir, `${base}_lipsync.json`), { force: true }).catch(() => {});
    res.json({ ok: true, text });
  } catch (err) {
    res.status(422).json({ error: `Retranslation failed: ${String(err.message || err).slice(0, 300)}` });
  }
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
  // instrumentEvalRoom is a transparent passthrough unless EVAL_LOG=1.
  if (!ncipRooms[roomId]) ncipRooms[roomId] = instrumentEvalRoom(new NcipRoom(roomId), roomId);
  return ncipRooms[roomId];
}

// pid -> live socketId for targeted emits (e.to is a participantId).
function socketFor(roomId, pid) {
  return ncipRooms[roomId]?.session.participants.get(pid)?.socketId || pid;
}

// Per-user lecture language: a member may override the room language for
// THEIR OWN audio/text — the class stays on the same segment index and
// slide; only the delivered payload is localized. rooms[roomId][pid].lang
// === null/undefined means "follow the room language".
function langFor(roomId, pid) {
  return rooms[roomId]?.[pid]?.lang
    || ncipRooms[roomId]?.language?.roomLanguage || 'en';
}

// Connected participants grouped by effective language — professor-speak is
// emitted once per distinct language so each member hears their own.
function connectedLangGroups(roomId) {
  const groups = new Map();
  for (const [pid, sess] of ncipRooms[roomId]?.session.participants || []) {
    if (!sess.connected) continue;
    const lang = langFor(roomId, pid);
    if (!groups.has(lang)) groups.set(lang, []);
    groups.get(lang).push(pid);
  }
  return groups;
}

// Per-language manifest cache on the run — overriding users need their own
// language's segment payloads; run.manifest stays the canonical (room) one.
async function manifestForLang(roomId, run, lang) {
  if (lang === ncipRooms[roomId]?.language?.roomLanguage) return run.manifest;
  (run.manifestByLang ??= {});
  if (!run.manifestByLang[lang]) {
    try {
      run.manifestByLang[lang] = await loadLectureManifest(run.lectureId, lang);
    } catch (err) {
      console.warn(`[agent] ${roomId}: per-user manifest '${lang}' failed:`, err.message);
      run.manifestByLang[lang] = run.manifest;
    }
  }
  return run.manifestByLang[lang];
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
  } finally {
    run.manifestSwap = null;
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
  // A language.switch is asynchronous — never let the next unit emit from a
  // stale-language manifest. Wait for the pending swap (bounded: the
  // manifest load is local disk I/O) before deciding.
  if (run.manifestSwap) await run.manifestSwap.catch(() => {});
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
        // Per-user language: one emit per distinct effective language — same
        // unitId/segment/slide for everyone, only text+audio localized.
        for (const [lang, pids] of connectedLangGroups(roomId)) {
          const m = await manifestForLang(roomId, run, lang);
          const lseg = m?.segments.find((s) => s.id === seg.id) || seg;
          const payload = {
            id: unitId,
            type: 'lecture',
            unitStartedAt: Date.now(),
            lectureId: run.lectureId,
            runId: run.runId,
            title: run.manifest.title,
            text: lseg.text,
            audioUrl: lseg.audioUrl,
            a2fUrl: lseg.a2fUrl || null,
            animation: lseg.animation,
            facialExpression: lseg.facialExpression,
            lipsync: lseg.lipsync,
            // Segment-level provenance wins over the topic's first page — the
            // board must follow THIS segment's page/document.
            slidePage: lseg.slidePage ?? action.slidePage ?? null,
            slideDoc: lseg.slideDoc ?? null,
            language: lang,
            stateVersion: ncip.stateVersion,
          };
          for (const pid of pids) io.to(socketFor(roomId, pid)).emit('professor-speak', payload);
        }
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
        // Per-user language: every distinct effective language gets its own
        // utterance — baked ones are cache hits. The room-language utterance
        // MUST succeed; a failing override language degrades to it.
        const groups = connectedLangGroups(roomId);
        const roomLang = ncip.language.roomLanguage;
        const langs = new Set(groups.keys());
        langs.add(roomLang); // generate even with no live listeners (legacy semantics)
        const timeoutMs = Number(process.env.NXR_UTTERANCE_TIMEOUT_MS || 45_000);
        const msgs = new Map();
        let roomErr = null;
        // Utterance timeout: a hung Ollama/TTS must never leave the room in a
        // synthetic "lecturing but silent" state. Fallbacks below apply.
        await Promise.all([...langs].map(async (lang) => {
          try {
            msgs.set(lang, await Promise.race([
              generateLectureUtterance({
                lectureId: run.lectureId,
                language: lang,
                purpose: action.purpose,
                topicId: action.topicId,
                topicTitle,
                sourceSegmentIds: action.sourceSegmentIds,
              }),
              new Promise((_, rej) => setTimeout(() =>
                rej(new Error(`utterance timeout (${action.purpose})`)), timeoutMs)),
            ]));
          } catch (e) { if (lang === roomLang) roomErr = e; msgs.set(lang, null); }
        }));
        const roomMsg = msgs.get(roomLang);
        if (roomErr || !roomMsg) throw (roomErr || new Error('room-language utterance failed'));
        if (ncipRooms[roomId]?.lectureRun !== run) return; // ended mid-generation
        const unitId = `${run.lectureId}_dyn_${run.dynSeq}`;
        run.currentUnit = { id: unitId, kind: 'dynamic', purpose: action.purpose, nextSegIndex, action };
        applyEffects(roomId, ncip.lectureUnitStarted());
        for (const [lang, pids] of groups) {
          const msg = msgs.get(lang) || roomMsg;
          const payload = {
            id: unitId,
            type: 'lecture',
            unitStartedAt: Date.now(),
            dynamic: action.purpose,
            lectureId: run.lectureId,
            runId: run.runId,
            title: run.manifest.title,
            text: msg.text,
            audioUrl: msg.audioUrl,
            a2fUrl: msg.a2fUrl || null,
            animation: msg.animation,
            facialExpression: msg.facialExpression,
            lipsync: msg.lipsync,
            durationMs: msg.durationMs,
            slidePage: action.slidePage ?? null,
            slideDoc: run.manifest.segments.find((s) => s.id === (action.sourceSegmentIds || [])[0])?.slideDoc ?? null,
            language: lang,
            stateVersion: ncip.stateVersion,
          };
          for (const pid of pids) io.to(socketFor(roomId, pid)).emit('professor-speak', payload);
        }
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
    // Per-recipient effective language — the member's personal override when
    // set, else the room language. Reconnects keep hearing their own choice.
    language: { ...(s.language || {}), myLanguage: langFor(roomId, pid) },
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
    // Reconnect-after-resume: THIS participant's projected position — its own
    // pause checkpoint + the wall-clock the class has played since resume.
    // null outside LECTURING or when no fresh checkpoint exists.
    resume: pid ? ncip.resumeProjection(pid) : null,
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
const ANSWER_END_SLACK_MS = 2000;
const ANSWER_END_UNKNOWN_MS = 15000;
const ANSWER_AUDIO_DIR = path.resolve(SERVER_DIR, '..', 'nexora_ai', 'lecture_cache', 'answers');

// durationMs missing (mock/legacy answers) → measure the answer WAV via
// its /answer_audio/<key> URL. The client 'answer-ended' report is the
// primary completion path — this timer is only a safety net for reports
// that never arrive.
function answerAudioDurationMs(audioUrl) {
  const m = /answer_audio\/([a-f0-9]{32})$/.exec(audioUrl || '');
  if (!m) return null;
  try {
    return wavDurationMs(readFileSync(path.join(ANSWER_AUDIO_DIR, `${m[1]}.wav`)));
  } catch { return null; }
}

function scheduleAnswerEnd(roomId, answerId, durationMs, audioUrl = null) {
  const ncip = ncipRooms[roomId];
  if (!ncip) return;
  let wait = Number.isFinite(durationMs) ? durationMs : answerAudioDurationMs(audioUrl);
  if (!Number.isFinite(wait)) wait = ANSWER_END_UNKNOWN_MS;
  wait += ANSWER_END_SLACK_MS;
  const timer = setTimeout(() => {
    roomTimers[roomId]?.delete(timer);
    const room = ncipRooms[roomId];
    if (!room) return;
    const was = room.professor.status === ProfessorStatus.ANSWERING
      && room.currentAnswer?.id === answerId;
    const t0 = Date.now();
    applyEffects(roomId, room.answerTimeExpired(answerId));
    if (was && room.professor.status !== ProfessorStatus.ANSWERING) {
      console.log(`[answer-end] ${answerId} durationMs=${durationMs ?? 'unknown'} ` +
        `clientAudioMs=- path=fallback commitMs=${Date.now() - t0}`);
    }
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
    evalEffect(roomId, e, ncip);
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
  const joinResult = ncip.joinParticipant(pid, socket.id, Date.now(), {
    passive: data?.passive === true,
  });
  evalInbound(roomId, pid, 'join', { name: safeName, isNew: joinResult.isNew, reconnected: joinResult.reconnected }, ncip);

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

// Segment barrier (eval feature, default ON): the room advances to the next
// lecture unit only when every CONNECTED participant has reported the
// current unit ended, or BARRIER_MAX_WAIT_MS after the first report.
// Faster clients wait at the boundary (empty queue, current slide still
// shown). Disconnected participants never block the barrier — a lagging
// client that drops simply stops counting.
const SEGMENT_BARRIER = (process.env.NXR_SEGMENT_BARRIER ?? '1') !== '0';
const BARRIER_MAX_WAIT_MS =
  Math.max(0, Number(process.env.NXR_BARRIER_MAX_WAIT_MS) || 5_000);

function barrierMissing(ncip, run) {
  const reporters = run?.barrier?.reporters;
  if (!reporters) return [];
  const out = [];
  for (const [pid, p] of ncip.session.participants) {
    // Passive participants (eval drivers/pads that never play audio) do
    // not block the barrier; disconnected participants don't either.
    if (p.connected && !p.passive && !reporters.has(pid)) out.push(pid);
  }
  return out;
}

// Advance the run iff every connected participant reported the barrier
// unit ended; otherwise arm (once) the max-wait timeout which advances
// anyway and logs the lagging clients. Called on each segment-ended
// report and on disconnect (a departing laggard unblocks the barrier).
function maybeAdvanceLectureBarrier(roomId) {
  const ncip = getNcipRoom(roomId);
  const run = ncip?.lectureRun;
  const barrier = run?.barrier;
  if (!run || !barrier) return;
  if (run.currentUnit?.id !== barrier.unitId) {
    clearTimeout(barrier.timer);
    run.barrier = null;
    return;
  }
  const missing = barrierMissing(ncip, run);
  if (missing.length === 0) {
    const waitedMs = Date.now() - barrier.armedAt;
    clearTimeout(barrier.timer);
    run.barrier = null;
    evalInbound(roomId, null, 'barrier-pass', { unitId: barrier.unitId, waitedMs }, ncip);
    emitNextLectureUnit(roomId).catch((err) =>
      console.error(`[agent] ${roomId}: progression error:`, err));
    return;
  }
  if (!barrier.timer) {
    const unitId = barrier.unitId;
    barrier.timer = setTimeout(() => {
      const room = ncipRooms[roomId];
      if (!room || room.lectureRun !== run || !run.barrier) return;
      const lagging = barrierMissing(room, run);
      console.warn(`[barrier] ${roomId}: unit ${unitId} timed out after ` +
        `${BARRIER_MAX_WAIT_MS}ms — lagging: ${lagging.join(', ') || 'none'}`);
      evalInbound(roomId, null, 'barrier-timeout', { unitId, lagging }, room);
      run.barrier = null;
      emitNextLectureUnit(roomId).catch((err) =>
        console.error(`[agent] ${roomId}: progression error:`, err));
    }, BARRIER_MAX_WAIT_MS);
    barrier.timer.unref?.();
    evalInbound(roomId, null, 'barrier-wait', { unitId, waitingFor: missing }, ncip);
  }
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
    const ncipKick = getNcipRoom(roomId);
    applyEffects(roomId, ncipKick.leave(userId));
    evalInbound(roomId, ctx.participantId, 'room.kick', { userId }, ncipKick);
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
    const ncip = getNcipRoom(roomId);
    applyEffects(roomId, ncip.leave(pid));
    evalInbound(roomId, pid, 'leave', null, ncip);
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
    evalInbound(ctx.roomId, ctx.participantId, 'session.sync', null, getNcipRoom(ctx.roomId));
    socket.emit('session.snapshot', buildSnapshotPayload(ctx.roomId, ctx.participantId));
  });

  // NCIP language.change: the server owns the room language — clients request,
  // the room state machine validates and broadcasts the authoritative result.
  socket.on('language.change', async ({ language } = {}) => {
    const ctx = socketCtx.get(socket.id);
    if (!ctx || !rooms[ctx.roomId]?.[ctx.participantId]) return;
    // Permission: room-wide language is a moderation action — only the room
    // host, an INSTRUCTOR, or a SUPER_ADMIN may change it. hostId is the
    // server-derived participant id from the registry (never client state).
    const langRoomMeta = roomRegistry.get(ctx.roomId);
    const langRole = socket.data?.user?.role;
    const canChangeLang = langRoomMeta?.hostId === ctx.participantId
      || langRole === 'INSTRUCTOR' || langRole === 'SUPER_ADMIN';
    if (!canChangeLang) {
      socket.emit('lecture-control', { action: 'language-error',
        error: 'Only the host can change the classroom language.' });
      return;
    }
    const ncip = getNcipRoom(ctx.roomId);
    // Availability gate: a prepared language has translated text and/or baked
    // audio in its language-keyed cache bucket. Rejecting unprepared langs
    // avoids a mid-lecture translate+TTS storm on every segment — the room
    // keeps the current language instead of degrading to English or stalling.
    const activeLid = ncip.lectureRun?.lectureId;
    if (activeLid && language !== 'en') {
      // Readiness gate: EVERY segment needs translated text AND baked audio —
      // a few files present is not enough; a partial bucket would lazy
      // translate+TTS mid-lecture on every segment.
      try {
        const { ready, readyCount, total } = await isLanguageReady(activeLid, language);
        if (!ready) {
          socket.emit('lecture-control', { action: 'language-error',
            error: `${LECTURE_LANG_LABELS[language] || String(language).toUpperCase()} is not ready for this lecture yet (${readyCount}/${total} segments).` });
          return;
        }
      } catch {
        socket.emit('lecture-control', { action: 'language-error',
          error: `${LECTURE_LANG_LABELS[language] || String(language).toUpperCase()} is not ready for this lecture yet.` });
        return;
      }
    }
    const result = ncip.changeLanguage(ctx.participantId, language);
    evalInbound(ctx.roomId, ctx.participantId, 'language.change', { language, ok: result.ok }, ncip);
    if (!result.ok) {
      socket.emit('lecture-control', { action: 'language-error', error: result.error });
      return;
    }
    applyEffects(ctx.roomId, result.effects);
    // V2: the next agent-emitted segment must be in the new room language —
    // swap the run's manifest. The promise is pinned on the run so
    // emitNextLectureUnit waits for it instead of racing ahead in English.
    const swapRun = ncip.lectureRun;
    if (swapRun) swapRun.manifestSwap = refreshLectureManifest(ctx.roomId);
  });

  // Per-user lecture language: any participant may override ONLY their own
  // audio/text — the class stays on the same segment index and slide. Picking
  // the room language clears the override (rejoins the shared channel).
  socket.on('language.mine', async ({ language } = {}) => {
    const ctx = socketCtx.get(socket.id);
    if (!ctx || !rooms[ctx.roomId]?.[ctx.participantId]) return;
    if (typeof language !== 'string' || !LANGUAGE_CODES.includes(language)) {
      socket.emit('lecture-control', { action: 'language-error', error: 'Unsupported language.' });
      return;
    }
    const ncip = getNcipRoom(ctx.roomId);
    const roomLang = ncip.language.roomLanguage || 'en';
    const override = language === roomLang ? null : language;
    // Availability gate: same rule as the room switch — never offer a
    // partially-baked language to anyone.
    const activeLid = ncip.lectureRun?.lectureId;
    if (activeLid && override) {
      try {
        const { ready, readyCount, total } = await isLanguageReady(activeLid, override);
        if (!ready) {
          socket.emit('lecture-control', { action: 'language-error',
            error: `${LECTURE_LANG_LABELS[override] || override.toUpperCase()} is not ready for this lecture yet (${readyCount}/${total} segments).` });
          return;
        }
      } catch (err) {
        socket.emit('lecture-control', { action: 'language-error', error: 'Could not verify that language.' });
        return;
      }
    }
    rooms[ctx.roomId][ctx.participantId].lang = override;
    evalInbound(ctx.roomId, ctx.participantId, 'language.mine', { language, override }, ncip);
    console.log(`[server] ${ctx.participantId} set personal lecture language: ${override || '(room)'}`);
    socket.emit('lecture-control', { action: 'language-mine', language });
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
    evalInbound(ctx.roomId, ctx.participantId, 'request-floor', null, ncip);
  });

  socket.on('cancel-floor-request', () => {
    if (!socketIsParticipant(socket)) return participantError(socket, 'cancel-floor-request');
    const ctx = socketCtx.get(socket.id);
    if (!ctx) return;
    console.log(`[server] cancel-floor-request: ${ctx.participantId} in room '${ctx.roomId}'`);
    const ncip = getNcipRoom(ctx.roomId);
    applyEffects(ctx.roomId, ncip.cancelRequest(ctx.participantId));
    evalInbound(ctx.roomId, ctx.participantId, 'cancel-floor-request', null, ncip);
  });

  socket.on('release-floor', () => {
    if (!socketIsParticipant(socket)) return participantError(socket, 'release-floor');
    const ctx = socketCtx.get(socket.id);
    if (!ctx) return;
    console.log(`[server] release-floor: ${ctx.participantId} in room '${ctx.roomId}'`);
    const ncip = getNcipRoom(ctx.roomId);
    applyEffects(ctx.roomId, ncip.releaseFloor(ctx.participantId));
    evalInbound(ctx.roomId, ctx.participantId, 'release-floor', null, ncip);
  });

  // Clients report their exact interrupted lecture position when the floor is
  // granted; the server stores it as the authoritative room checkpoint.
  socket.on('lecture-checkpoint', (data) => {
    if (!socketIsParticipant(socket)) return participantError(socket, 'lecture-checkpoint');
    const ctx = socketCtx.get(socket.id);
    if (!ctx || !rooms[ctx.roomId]?.[ctx.participantId]) return;
    const ncip = getNcipRoom(ctx.roomId);
    applyEffects(ctx.roomId, ncip.submitCheckpoint(ctx.participantId, data));
    evalInbound(ctx.roomId, ctx.participantId, 'lecture-checkpoint', data, ncip);
    // Checkpoint accepted => floor is ready: arm the 30s question timeout.
    syncFloorTimer(ctx.roomId, ctx.participantId);
  });

  // Per-learner resume checkpoint: EVERY participant reports its own paused
  // position on pause-for-floor (sentence + fraction in its own language's
  // alignment). Stored per-pid and carried back to each client on 'resume' —
  // survives a mid-pause reconnect via the same store.
  socket.on('lecture-checkpoint-mine', (data) => {
    if (!socketIsParticipant(socket)) return participantError(socket, 'lecture-checkpoint-mine');
    const ctx = socketCtx.get(socket.id);
    if (!ctx || !rooms[ctx.roomId]?.[ctx.participantId]) return;
    const ncip = getNcipRoom(ctx.roomId);
    ncip.recordParticipantCheckpoint(ctx.participantId, data);
    evalInbound(ctx.roomId, ctx.participantId, 'lecture-checkpoint-mine', data, ncip);
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
    evalInbound(roomId, pid, 'ask-floor-question', { question, kind: data?.kind ?? null }, ncip);
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
        a2fUrl: msg.a2fUrl || null,
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
      scheduleAnswerEnd(roomId, answerId, durationMs, msg.audioUrl);
      // V2.2: record the interaction + run the clarification classifier in the
      // background; the agent's decide() sees the flag on next advancement.
      if (data?.kind !== 'recap') {
        maybeRecordClarification(roomId, question, msg?.text, ctx.participantId).catch(() => {});
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
    const ncip = getNcipRoom(ctx.roomId);
    // Capture answer state BEFORE the transition — _finishAnswer clears it.
    const ans = ncip?.professor.status === ProfessorStatus.ANSWERING
      ? ncip.currentAnswer : null;
    const was = ans && ans.id === data?.id;
    const t0 = Date.now();
    applyEffects(ctx.roomId, ncip.answerEnded(data?.id));
    if (was && ncip.professor.status !== ProfessorStatus.ANSWERING) {
      console.log(`[answer-end] ${data?.id} durationMs=${ans.durationMs ?? 'unknown'} ` +
        `clientAudioMs=${data?.audioMs ?? '-'} reportedAfter=${Date.now() - ans.startedAt}ms ` +
        `path=client commitMs=${Date.now() - t0}`);
    }
    evalInbound(ctx.roomId, ctx.participantId, 'answer-ended', { id: data?.id }, ncip);
  });

  socket.on('state-update', (data) => {
    const ctx = socketCtx.get(socket.id);
    if (!ctx || !rooms[ctx.roomId]?.[ctx.participantId]) return;

    const user = rooms[ctx.roomId][ctx.participantId];
    // Partial updates are allowed (e.g. an avatar-only change): patch only
    // the fields the client sent so a sparse emit can't wipe presence state.
    if (data.position) user.position = data.position;
    if (data.rotation) user.rotation = data.rotation;
    if (data.animation) user.animation = data.animation;
    if (data.avatar) user.avatar = data.avatar;
    if (typeof data.name === 'string' && data.name.trim()) {
      user.name = data.name.trim().slice(0, 64);
    }
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
    evalInbound(ctx.roomId, ctx.participantId, 'professor-speak', { id: data?.id, type: data?.type }, ncip);
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
    // End/pause/resume: room owner, INSTRUCTOR, or SUPER_ADMIN — all room
    // types. The ncip side enforces lecture-state correctness (hostPause only
    // acts from a clean LECTURING state), so permission is the only gate here.
    const isOwner = meta.hostId === ctx.participantId;
    const isAdmin = socket.data?.user?.role === 'SUPER_ADMIN';
    const isInstructor = socket.data?.user?.role === 'INSTRUCTOR';
    if (!isOwner && !isAdmin && !isInstructor) {
      socket.emit('lecture-control', { action: 'control-error',
        error: 'Only the classroom owner, an instructor, or a super admin can control the lecture.' });
      return;
    }
    const ncip = getNcipRoom(ctx.roomId);
    let result = null;
    if (data?.action === 'pause') result = ncip.hostPause(ctx.participantId);
    else if (data?.action === 'resume') result = ncip.hostResume(ctx.participantId);
    else if (data?.action === 'end') {
      console.log(`[server] ${ctx.participantId} ended the lecture in '${ctx.roomId}'`);
      ncip.lectureRun = null;
      applyEffects(ctx.roomId, ncip.endLecture(ctx.participantId));
      evalInbound(ctx.roomId, ctx.participantId, 'lecture-control', { action: 'end' }, ncip);
      // Tell every client to stop and clear its local lecture queue — unlike
      // endLecture's implicit drain path, this is an explicit host command.
      io.to(ctx.roomId).emit('lecture-control', { action: 'end' });
      return;
    } else return;
    evalInbound(ctx.roomId, ctx.participantId, 'lecture-control', { action: data?.action, ok: result.ok }, ncip);
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
    evalInbound(ctx.roomId, ctx.participantId, 'lecture-ended', null, ncip);
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
    // A room bound to a lecture can only ever teach that lecture — a client
    // carrying a different ?lecture= cannot hijack the room's content.
    const boundMeta = roomRegistry.get(roomId);
    if (boundMeta?.lectureId && boundMeta.lectureId !== lectureId) {
      socket.emit('lecture-control', { action: 'control-error',
        error: `This classroom is bound to lecture '${boundMeta.lectureId}'.` });
      return;
    }
    // A class may only start when the lecture is fully ready in EVERY
    // supported language — otherwise a mid-lecture switch can hit an
    // unbaked language and students hear the wrong language or nothing.
    // NXR_START_REQUIRES_ALL_LANGS=0 skips this (e2e fixtures whose lectures
    // only exist in English); production always enforces.
    const readiness = process.env.NXR_START_REQUIRES_ALL_LANGS === '0'
      ? { allReady: true, missing: [] }
      : await lectureReadiness(lectureId).catch(() => null);
    if (!readiness || !readiness.allReady) {
      const detail = readiness?.missing?.length
        ? `Not ready: ${readiness.missing.join('; ')}`
        : `Lecture '${lectureId}' has no playable manifest`;
      socket.emit('lecture-control', { action: 'control-error', error: `Cannot start class — ${detail}` });
      return;
    }
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
      evalInbound(roomId, ctx.participantId, 'lecture.start', { lectureId }, ncip);
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
    evalInbound(roomId, ctx.participantId, 'lecture-segment-ended', { messageId: claimed }, ncip);
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
    if (!SEGMENT_BARRIER) {
      emitNextLectureUnit(roomId).catch((err) =>
        console.error(`[agent] ${roomId}: progression error:`, err));
      return;
    }
    // Segment barrier: the room advances only once every CONNECTED
    // participant reports this unit ended, or BARRIER_MAX_WAIT_MS after the
    // first report. Disconnected participants never block the barrier.
    const barrier = run.barrier ??= {
      unitId: claimed, reporters: new Set(), timer: null, armedAt: Date.now(),
    };
    if (barrier.unitId !== claimed) {
      clearTimeout(barrier.timer);
      run.barrier = {
        unitId: claimed, reporters: new Set(), timer: null, armedAt: Date.now(),
      };
    }
    run.barrier.reporters.add(ctx.participantId);
    maybeAdvanceLectureBarrier(roomId);
  });

  socket.on('chat', (data) => {
    const ctx = socketCtx.get(socket.id);
    if (!ctx) return;
    evalInbound(ctx.roomId, ctx.participantId, 'chat', { text: data?.text }, ncipRooms[ctx.roomId]);
    socket.broadcast.to(ctx.roomId).emit('chat', { from: data.name || ctx.participantId, text: data.text });
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
    evalInbound(roomId, pid, 'disconnect', null, ncip);
    if (ncip.participantDisconnected(pid)) {
      console.log(`[server] disconnect: ${pid} offline in '${roomId}' — ${ncip.RECONNECT_GRACE_MS}ms grace`);
      emitFloorState(roomId); // participants list shows them offline
      // A disconnecting laggard no longer blocks the segment barrier.
      maybeAdvanceLectureBarrier(roomId);
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
  resumeInterruptedDocs();
  // Backfill: every lecture that is not allReady in all six languages gets
  // its missing segments/utterances queued — sequential, incremental.
  if (process.env.NXR_REPAIR_ON_BOOT !== '0') {
    setTimeout(() => repairIncompleteOnBoot(), 10_000); // let services settle first
  }
}).catch((e) => console.error('[db] init failed:', e.message));

httpServer.listen(port, '0.0.0.0', () => {
  console.log(`Professor Abed is listening on port ${port}`);
});