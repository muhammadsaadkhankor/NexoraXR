import 'dotenv/config';
import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import fs from 'fs/promises';
import { openAIChain, parser } from "../nexora_ai/modules/openAI.mjs";
import { lipSync } from "../nexora_ai/modules/lip-sync.mjs";
import { sendDefaultMessages, defaultResponse } from "../nexora_ai/modules/defaultMessages.mjs";
import { voice, initializeElevenLabs } from "../nexora_ai/modules/elevenLabs.mjs";
import { createServer } from "http";
import { Server } from "socket.io";
import lectureRouter from "../nexora_ai/routes/lectureRoutes.mjs";
import { NcipRoom, ProfessorStatus } from "./protocol/ncipRoom.mjs";

dotenv.config();

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(cors());
const port = process.env.PORT || 3000;

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
app.get("/settings", async (req, res) => {
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
app.post("/settings", async (req, res) => {
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

app.use('/api', lectureRouter);

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const rooms = {}; // roomId -> { [participantId]: player }
const socketCtx = new Map(); // socketId -> { roomId, participantId }
const ncipRooms = {};
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
  if (rooms[roomId] && Object.keys(rooms[roomId]).length === 0) {
    delete rooms[roomId];
    delete ncipRooms[roomId];
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
  }
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
function buildSnapshotPayload(roomId) {
  const ncip = getNcipRoom(roomId);
  const s = ncip.snapshot();
  return {
    ...s,
    floor: {
      holder: s.floor.holder
        ? { userId: s.floor.holder, name: nameFor(roomId, s.floor.holder) }
        : null,
      queue: s.floor.queue.map((id) => ({ userId: id, name: nameFor(roomId, id) })),
    },
  };
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
    const payload = { ...(data || {}), stateVersion: ncip.stateVersion };
    if (e.to && e.to !== 'room') {
      io.to(socketFor(roomId, e.to)).emit(e.event, payload);
    } else {
      io.to(roomId).emit(e.event, payload);
    }
  }
}

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('join', (data) => {
    const roomId = data.roomId || 'default';

    const safeName = typeof data.name === 'string' ? data.name.trim().slice(0, 30) : '';
    if (!safeName) {
      console.log(`[server] join rejected for ${socket.id}: invalid name`);
      socket.emit('join-error', { error: 'A valid display name is required to join.' });
      return;
    }

    // NCIP Slice 4: the client supplies a stable participantId persisted
    // across reconnects; socket.id is only the current transport binding.
    const pid = typeof data.participantId === 'string' && data.participantId.length <= 64
      ? data.participantId
      : socket.id;

    socket.join(roomId);
    socketCtx.set(socket.id, { roomId, participantId: pid });

    if (!rooms[roomId]) rooms[roomId] = {};
    const ncip = getNcipRoom(roomId);
    const joinResult = ncip.joinParticipant(pid, socket.id);

    // A reconnect during the grace window cancels the pending expiry.
    const graceKey = `${roomId} ${pid}`;
    if (graceTimers.has(graceKey)) {
      clearTimeout(graceTimers.get(graceKey));
      graceTimers.delete(graceKey);
    }

    const user = {
      userId: pid,
      roomId,
      name: safeName,
      avatar: data.avatar || '/assets/useravatar/avatars/UserAvatar.glb',
      position: data.position || [0, 0, 0],
      rotation: data.rotation || [0, 0, 0],
      animation: data.animation || 'Idle',
      timestamp: Date.now()
    };

    rooms[roomId][pid] = user;
    const members = Object.keys(rooms[roomId]);
    console.log(`[server] join: ${pid} (${socket.id}) joined room '${roomId}' (members: ${members.length}, reconnected: ${joinResult.reconnected})`);

    socket.broadcast.to(roomId).emit('user-joined', user);
    socket.emit('room-state', Object.values(rooms[roomId]).filter((p) => p.userId !== pid));
    emitFloorState(roomId, socket);
    // Slice 2+4: joiners AND reconnectors get the authoritative snapshot —
    // floor ownership/queue position survived the grace window.
    socket.emit('session.snapshot', buildSnapshotPayload(roomId));
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
  socket.on('session.sync', () => {
    const ctx = socketCtx.get(socket.id);
    if (!ctx || !rooms[ctx.roomId]?.[ctx.participantId]) return;
    socket.emit('session.snapshot', buildSnapshotPayload(ctx.roomId));
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
  });

  // NCIP floor.request: dedupe; auto-grant when the floor is free, else FIFO queue.
  socket.on('request-floor', () => {
    const ctx = socketCtx.get(socket.id);
    if (!ctx || !rooms[ctx.roomId]?.[ctx.participantId]) return;
    const ncip = getNcipRoom(ctx.roomId);
    console.log(`[server] request-floor: ${ctx.participantId} in room '${ctx.roomId}' (status: ${ncip.professor.status})`);
    applyEffects(ctx.roomId, ncip.requestFloor(ctx.participantId));
  });

  socket.on('cancel-floor-request', () => {
    const ctx = socketCtx.get(socket.id);
    if (!ctx) return;
    console.log(`[server] cancel-floor-request: ${ctx.participantId} in room '${ctx.roomId}'`);
    applyEffects(ctx.roomId, getNcipRoom(ctx.roomId).cancelRequest(ctx.participantId));
  });

  socket.on('release-floor', () => {
    const ctx = socketCtx.get(socket.id);
    if (!ctx) return;
    console.log(`[server] release-floor: ${ctx.participantId} in room '${ctx.roomId}'`);
    applyEffects(ctx.roomId, getNcipRoom(ctx.roomId).releaseFloor(ctx.participantId));
  });

  // Clients report their exact interrupted lecture position when the floor is
  // granted; the server stores it as the authoritative room checkpoint.
  socket.on('lecture-checkpoint', (data) => {
    const ctx = socketCtx.get(socket.id);
    if (!ctx || !rooms[ctx.roomId]?.[ctx.participantId]) return;
    applyEffects(ctx.roomId, getNcipRoom(ctx.roomId).submitCheckpoint(ctx.participantId, data));
    // Checkpoint accepted => floor is ready: arm the 30s question timeout.
    syncFloorTimer(ctx.roomId, ctx.participantId);
  });

  // NCIP question.submit: only the current floor holder, only while PAUSED.
  socket.on('ask-floor-question', async (data) => {
    const ctx = socketCtx.get(socket.id);
    if (!ctx || !rooms[ctx.roomId]?.[ctx.participantId]) return;
    const roomId = ctx.roomId;
    const pid = ctx.participantId;

    const ncip = getNcipRoom(roomId);
    const question = typeof data?.question === 'string' ? data.question.trim().slice(0, 500) : '';
    if (!question) return;

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

    try {
      const res = await fetch(`http://localhost:${port}/api/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, lectureId: data.lectureId })
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
      clearThinkingTimers(roomId); // THINKING -> ANSWERING disarms the timeout
      console.log(`[ncip:metrics] ${roomId}: question.submit -> answer.start = ${Date.now() - submittedAt}ms`);
      scheduleAnswerEnd(roomId, answerId, durationMs);
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
    console.log(`[server] professor-speak from ${ctx.participantId} to room ${ctx.roomId}:`, data?.text);
    // A lecture-segment head is also the authoritative live playback position
    // — record it so late joiners can recover an in-progress lecture.
    const seg = /^(.+)_seg_(\d+)$/.exec(data?.id || '');
    if (data?.type === 'lecture' && seg && seg[1] !== 'none') {
      applyEffects(ctx.roomId, getNcipRoom(ctx.roomId).updatePlayback(ctx.participantId, {
        lectureId: seg[1],
        segmentIndex: Number(seg[2]),
        playbackOffsetMs: 0,
      }));
    }
    io.to(ctx.roomId).emit('professor-speak', data);
  });

  // The lecture queue drained on a client — clear the live position so
  // snapshots don't offer a stale segment to late joiners.
  socket.on('lecture-ended', () => {
    const ctx = socketCtx.get(socket.id);
    if (!ctx) return;
    applyEffects(ctx.roomId, getNcipRoom(ctx.roomId).endLecture(ctx.participantId));
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

  // NCIP Slice 4: a dropped socket does NOT remove the participant — it
  // marks them offline and opens the 10s reconnect grace window. Presence,
  // floor ownership and queue position are preserved until expiry.
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
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

httpServer.listen(port, '0.0.0.0', () => {
  console.log(`Professor Abed is listening on port ${port}`);
});