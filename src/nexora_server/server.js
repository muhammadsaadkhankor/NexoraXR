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

const rooms = {};
const socketRoom = new Map();
const ncipRooms = {};

function getNcipRoom(roomId) {
  if (!ncipRooms[roomId]) ncipRooms[roomId] = new NcipRoom(roomId);
  return ncipRooms[roomId];
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
    const room = ncipRooms[roomId];
    if (!room) return;
    applyEffects(roomId, room.answerTimeExpired(answerId));
  }, wait);
  timer.unref?.();
}

function applyEffects(roomId, effects) {
  for (const e of effects || []) {
    if (e.event === 'floor-state') {
      emitFloorState(roomId);
      continue;
    }
    const data = enrichEffectData(roomId, e.event, e.data);
    if (e.to && e.to !== 'room') {
      io.to(e.to).emit(e.event, data);
    } else {
      io.to(roomId).emit(e.event, data);
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

    socket.join(roomId);
    socketRoom.set(socket.id, roomId);

    if (!rooms[roomId]) rooms[roomId] = {};

    const user = {
      userId: socket.id,
      roomId,
      name: safeName,
      avatar: data.avatar || '/assets/useravatar/avatars/UserAvatar.glb',
      position: data.position || [0, 0, 0],
      rotation: data.rotation || [0, 0, 0],
      animation: data.animation || 'Idle',
      timestamp: Date.now()
    };

    rooms[roomId][socket.id] = user;
    const members = Object.keys(rooms[roomId]);
    console.log(`[server] join: ${socket.id} joined room '${roomId}' (members: ${members.length})`);

    socket.broadcast.to(roomId).emit('user-joined', user);
    console.log(`[server] emitted 'user-joined' for ${socket.id} to room ${roomId}`);
    socket.emit('room-state', Object.values(rooms[roomId]).filter((p) => p.userId !== socket.id));
    console.log(`[server] emitted 'room-state' to ${socket.id}:`, Object.values(rooms[roomId]).map((p) => p.userId));
    emitFloorState(roomId, socket);
    const ncip = getNcipRoom(roomId);
    if (ncip.professor.status === ProfessorStatus.PAUSED ||
        ncip.professor.status === ProfessorStatus.THINKING ||
        ncip.professor.status === ProfessorStatus.ANSWERING) {
      socket.emit('lecture-control', {
        action: 'pause-for-floor',
        activeSpeaker: ncip.floor.holder
          ? { userId: ncip.floor.holder, name: nameFor(roomId, ncip.floor.holder) }
          : null
      });
    }
  });

  // NCIP floor.request: dedupe; auto-grant when the floor is free, else FIFO queue.
  socket.on('request-floor', () => {
    const roomId = socketRoom.get(socket.id);
    if (!roomId || !rooms[roomId]?.[socket.id]) return;
    const ncip = getNcipRoom(roomId);
    console.log(`[server] request-floor: ${socket.id} in room '${roomId}' (status: ${ncip.professor.status})`);
    applyEffects(roomId, ncip.requestFloor(socket.id));
  });

  socket.on('cancel-floor-request', () => {
    const roomId = socketRoom.get(socket.id);
    if (!roomId) return;
    console.log(`[server] cancel-floor-request: ${socket.id} in room '${roomId}'`);
    applyEffects(roomId, getNcipRoom(roomId).cancelRequest(socket.id));
  });

  socket.on('release-floor', () => {
    const roomId = socketRoom.get(socket.id);
    if (!roomId) return;
    console.log(`[server] release-floor: ${socket.id} in room '${roomId}'`);
    applyEffects(roomId, getNcipRoom(roomId).releaseFloor(socket.id));
  });

  // Clients report their exact interrupted lecture position when the floor is
  // granted; the server stores it as the authoritative room checkpoint.
  socket.on('lecture-checkpoint', (data) => {
    const roomId = socketRoom.get(socket.id);
    if (!roomId || !rooms[roomId]?.[socket.id]) return;
    applyEffects(roomId, getNcipRoom(roomId).submitCheckpoint(socket.id, data));
  });

  // NCIP question.submit: only the current floor holder, only while PAUSED.
  socket.on('ask-floor-question', async (data) => {
    const roomId = socketRoom.get(socket.id);
    if (!roomId || !rooms[roomId]?.[socket.id]) return;

    const ncip = getNcipRoom(roomId);
    const question = typeof data?.question === 'string' ? data.question.trim().slice(0, 500) : '';
    if (!question) return;

    const result = ncip.submitQuestion(socket.id, question);
    if (!result.ok) {
      socket.emit('floor-question-error', { error: result.error });
      return;
    }
    applyEffects(roomId, result.effects);

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
      const answerId = `floor_${roomId}_${Date.now()}`;
      const durationMs = Number.isFinite(msg.durationMs) ? msg.durationMs : null;
      // Host-relative audio URL — remote clients resolve it against the
      // backend origin they already use (API_URL on the frontend).
      applyEffects(roomId, ncip.answerReady(answerId, {
        type: 'answer',
        askedBy: socket.id,
        text: msg.text,
        animation: msg.animation,
        facialExpression: msg.facialExpression,
        audioUrl: msg.audioUrl || null,
        lipsync: msg.lipsync
      }, durationMs));
      scheduleAnswerEnd(roomId, answerId, durationMs);
    } catch (err) {
      console.error('[server] ask-floor-question failed:', err);
      applyEffects(roomId, ncip.answerFailed(
        socket.id,
        'The professor could not answer right now. Please try again.'
      ));
    }
  });

  // NCIP answer.end: clients report when the answer audio finished playing;
  // the first report for the current answer advances the protocol.
  socket.on('answer-ended', (data) => {
    const roomId = socketRoom.get(socket.id);
    if (!roomId) return;
    applyEffects(roomId, getNcipRoom(roomId).answerEnded(data?.id));
  });

  socket.on('state-update', (data) => {
    const roomId = socketRoom.get(socket.id);
    if (!roomId || !rooms[roomId]?.[socket.id]) return;

    const user = rooms[roomId][socket.id];
    user.position = data.position;
    user.rotation = data.rotation;
    user.animation = data.animation;
    user.timestamp = Date.now();

    socket.broadcast.to(roomId).emit('state-update', user);
  });

  socket.on('professor-speak', (data) => {
    const roomId = socketRoom.get(socket.id);
    if (!roomId) return;
    console.log(`[server] professor-speak from ${socket.id} to room ${roomId}:`, data?.text);
    io.to(roomId).emit('professor-speak', data);
  });

  socket.on('chat', (data) => {
    const roomId = socketRoom.get(socket.id);
    if (roomId) socket.broadcast.to(roomId).emit('chat', { from: data.name || socket.id, text: data.text });
  });

  // WebRTC signaling relay for peer voice chat: forwards offers, answers and
  // ICE candidates to a specific room member. Media flows peer-to-peer; the
  // server only shuttles SDP/ICE.
  socket.on('webrtc-signal', ({ to, data }) => {
    const roomId = socketRoom.get(socket.id);
    if (!roomId || !to || !data || !rooms[roomId]?.[to]) return;
    io.to(to).emit('webrtc-signal', { from: socket.id, data });
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    const roomId = socketRoom.get(socket.id);
    if (roomId && rooms[roomId]) {
      delete rooms[roomId][socket.id];
      const ncip = getNcipRoom(roomId);
      const members = Object.keys(rooms[roomId]);
      console.log(`[server] disconnect: ${socket.id} left room '${roomId}' (members: ${members.length})`);
      socket.broadcast.to(roomId).emit('user-left', { userId: socket.id });
      applyEffects(roomId, ncip.disconnect(socket.id));
      socketRoom.delete(socket.id);
      if (members.length === 0) delete ncipRooms[roomId];
    }
  });
});

httpServer.listen(port, '0.0.0.0', () => {
  console.log(`Professor Abed is listening on port ${port}`);
});