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
import { RoomRegistry } from "./protocol/roomRegistry.mjs";

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

// Unified classroom creation — public rooms become discoverable, private rooms
// return an invite URL whose token is the only way in.
app.post('/api/rooms', (req, res) => {
  const { className, courseId, lectureId, language, roomType, hostId, scene } = req.body || {};
  const { room, error } = roomRegistry.create({ roomType, className, courseId, lectureId, language, hostId, scene });
  if (error) return res.status(400).json({ error });
  // Never log the invite token.
  console.log(`[rooms] ${room.roomType} room ${room.roomId} '${room.className}' created (lecture ${room.lectureId}, lang ${room.language})`);
  const scenePath = `/scene/${encodeURIComponent(room.scene)}?room=${room.roomId}${room.lectureId ? `&lecture=${room.lectureId}` : ''}`;
  res.status(201).json({
    roomId: room.roomId,
    roomType: room.roomType,
    joinUrl: `${scenePath}`,
    ...(room.roomType === 'private' ? { inviteUrl: `${scenePath}&invite=${room.inviteToken}` } : {}),
  });
});

// Backward-compatible private-only endpoint (delegates to the unified path).
app.post('/api/rooms/private', (req, res) => {
  const b = req.body || {};
  const { room, error } = roomRegistry.create({
    ...b,
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

// Gallery listing — safe public metadata only (no inviteToken/internals).
app.get('/api/rooms/public', (_req, res) => {
  res.json({ rooms: roomRegistry.listPublic() });
});

// Room meta for clients that followed an invite link — the registry scene is
// authoritative, so a link built with a bad/fallback scene can't drop guests
// into a different classroom model. Safe fields only (never inviteToken).
app.get('/api/rooms/:roomId', (req, res) => {
  const room = roomRegistry.get(req.params.roomId);
  if (!room) return res.status(404).json({ error: 'Not found' });
  const { roomId, roomType, className, courseId, lectureId, language, scene } = room;
  res.json({ roomId, roomType, className, courseId, lectureId, language, scene });
});

// Returns the room's current invite link (stable, reusable — host approval
// gates entry). rotate:true mints a new link and kills the old one — the host
// uses that to revoke a link that spread too far. hostId must match the
// registry record (no client-supplied authority).
app.post('/api/rooms/:roomId/invite', (req, res) => {
  const room = roomRegistry.get(req.params.roomId);
  if (!room || room.roomType !== 'private') {
    return res.status(404).json({ error: 'Not found' });
  }
  if (room.hostId !== req.body?.hostId) {
    return res.status(403).json({ error: 'Only the host can generate invite links' });
  }
  const rot = req.body?.rotate === true
    ? roomRegistry.rotateInvite(req.params.roomId, req.body?.hostId)
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
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const rooms = {}; // roomId -> { [participantId]: player }
const socketCtx = new Map(); // socketId -> { roomId, participantId }
const ncipRooms = {};
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
    // Emptied registry room => it dies with the NCIP room (in-memory
    // lifetime); public cards disappear, private invite links stop working.
    roomRegistry.remove(roomId);
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
    const payload = { ...(data || {}), stateVersion: ncip.stateVersion };
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

// Post-admission join path — shared by public/private joins and by host
// approval of a pending private guest.
function finishJoin(socket, data, roomId, registryRoom = null) {
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
    avatar: data.avatar || '/assets/useravatar/avatars/anim_male_1.glb',
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
  socket.emit('session.snapshot', buildSnapshotPayload(roomId, pid));
}

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('join', (data) => {
    let roomId = data.roomId || 'default';
    let registryRoom = null;

    if (data.room) {
      // Registry-room join (public or private). The room must already exist —
      // never create one from a join attempt.
      const meta = roomRegistry.get(data.room);
      if (!meta) {
        socket.emit('join-error', { error: 'This classroom link is invalid or has expired.', private: true });
        return;
      }
      if (meta.roomType === 'private' && data.participantId !== meta.hostId) {
        // A participant already admitted to this room (known to NCIP) is
        // reconnecting — invites gate NEW members only; don't burn a token.
        const known = ncipRooms[meta.roomId]?.session?.participants?.has?.(data.participantId);
        if (known) {
          registryRoom = meta;
          roomId = meta.roomId;
          finishJoin(socket, data, roomId, registryRoom);
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

    finishJoin(socket, data, roomId, registryRoom);
  });

  // Host decision on a pending private-room guest. Only the room's hostId
  // (from the registry — the socket's own participant binding) may decide.
  socket.on('private-join-decision', ({ socketId, accept } = {}) => {
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
    // Catch Me Up is a public-classroom feature — private rooms reject it
    // outright (canCatchUp is already false for them; this is the hard gate).
    if (data?.kind === 'recap' && ncip.roomType === 'private') {
      socket.emit('floor-question-error', { error: 'Catch Me Up is not available in private rooms.' });
      return;
    }
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

    // V1 catch-up: kind 'recap' routes to /api/recap with the requesting
    // participant's join anchor; anything else is a normal /api/ask question.
    let apiPath = '/api/ask';
    let apiBody = {
      question,
      lectureId: data.lectureId,
      language: ncip.language.roomLanguage, // answer text locked to room language
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
  // Host lecture lifecycle (private rooms only — public rooms have no manual
  // pause/resume and guests can never reach this path).
  socket.on('lecture-control', (data) => {
    const ctx = socketCtx.get(socket.id);
    if (!ctx) return;
    const meta = roomRegistry.get(ctx.roomId);
    if (!meta || meta.roomType !== 'private') return; // public behavior unchanged
    if (!isRoomHost(ctx.roomId, ctx.participantId)) {
      socket.emit('lecture-control', { action: 'control-error', error: 'Only the host can control the lecture.' });
      return;
    }
    const ncip = getNcipRoom(ctx.roomId);
    let result = null;
    if (data?.action === 'pause') result = ncip.hostPause(ctx.participantId);
    else if (data?.action === 'resume') result = ncip.hostResume(ctx.participantId);
    else if (data?.action === 'end') {
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
    const ctx = socketCtx.get(socket.id);
    if (!ctx) return;
    // Private rooms: only the host may end the shared lecture — a guest's
    // local queue draining must not reset the room's position.
    if (roomRegistry.isPrivate(ctx.roomId) && !isRoomHost(ctx.roomId, ctx.participantId)) return;
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

httpServer.listen(port, '0.0.0.0', () => {
  console.log(`Professor Abed is listening on port ${port}`);
});