# Dtalk — Interactive Avatar Chatbot — Technical Reverse-Engineering Report

> **Scope:** This report is based on direct inspection of the implementation files in `/home/saadkhankori/Desktop/master-thesis/dtalk`. No code was modified. API keys are not exposed; they are described only by environment variable name.

---

## 1. Repository Overview

### What the project does

**Dtalk** is a browser-based, single-user “digital professor” chatbot. A 3D avatar (Professor Abed by default) is rendered with Three.js/React. The user can type or hold a microphone button to speak; the application sends the input to an Express backend, which calls OpenAI for a response and ElevenLabs for text-to-speech (TTS). The backend then runs **Rhubarb Lip Sync** over the generated audio to produce a mouth-cue timeline. The frontend plays the audio and animates the avatar’s mouth, face, and body using the returned `animation`, `facialExpression`, and `lipsync` data.

### Main user-facing functionality

1. Type a message or press/hold the microphone button to talk.
2. The avatar generates an audio reply and lip-sync/morph/animation data.
3. The 3D scene plays the audio and drives the avatar’s facial morph targets and skeletal animation.
4. An “API Settings” panel can read and overwrite the backend `.env` at runtime.
5. A “Change Avatar” file picker can swap the `.glb` model locally.
6. A “Record” button (auto-triggered by any bot message) captures the `<canvas>` to a WebM/MP4 video.

### Major technologies / frameworks

| Layer | Technology |
|---|---|
| Frontend framework | React 18 + Vite 5 |
| 3D rendering | Three.js 0.160, `@react-three/fiber`, `@react-three/drei`, `@react-three/xr` |
| UI styling | Tailwind CSS, `lucide-react` icons, `leva` debug controls |
| Backend | Node.js 18, Express 4 |
| AI / parsing | LangChain 0.1, `@langchain/openai`, `openai` SDK, Zod |
| TTS | `elevenlabs-node` → ElevenLabs REST API |
| ASR | Browser `webkitSpeechRecognition` (Google) in `useSpeech.jsx`; backend `whisper.mjs` is fully commented out and **not wired in** |
| Lip sync | Rhubarb Lip Sync (`./bin/rhubarb`) invoked by `child_process` |
| Audio tooling | FFmpeg (`ffmpeg`/`ffprobe`) |
| Deployment | Docker Compose with Node 18 images; native `npm run dev` also supported |

### Languages

- **JavaScript / JSX** (ES modules, `"type": "module"`) — frontend and backend.
- **GLB/FBX** binary assets for avatars and animations.
- **Shell** in `run_app.sh`.

### Subsystem mapping

- **Frontend:** `frontend/src/App.jsx`, `frontend/src/components/*`, `frontend/src/hooks/useSpeech.jsx`, `frontend/public/models/*`, `frontend/public/animations/*`.
- **Backend API:** `backend/server.js`.
- **AI/LLM:** `backend/modules/openAI.mjs`.
- **TTS:** `backend/modules/elevenLabs.mjs`.
- **Lip sync:** `backend/modules/lip-sync.mjs`, `backend/modules/rhubarbLipSync.mjs`, `backend/utils/files.mjs`.
- **Avatar/3D:** `frontend/src/components/Avatar.jsx`, `frontend/src/components/Scenario.jsx`, constants `facialExpressions.js`, `visemesMapping.js`, `morphTargets.js`.
- **Speech (browser):** `frontend/src/hooks/useSpeech.jsx`.
- **Storage:** filesystem only (`backend/audios/`); no database or vector store.
- **Deployment:** `docker-compose.yml`, `backend/Dockerfile`, `frontend/Dockerfile`, `run_app.sh`.

### How the project is started

- **Native:** `npm install` in root/backend/frontend, then `npm run dev` (uses `concurrently` to run `vite` on 5173 and `nodemon server.js` on 3000).
- **Docker:** `docker-compose build && docker-compose up -d` exposes 5173 and 3000.
- **Helper script:** `run_app.sh` installs missing `node_modules`, warns if `backend/.env` is missing, and launches both processes; it terminates both if either dies.

### Concise architecture summary

```
Browser (React/Three.js)
  ├─ ChatInterface & useSpeech.jsx ──→ HTTP POST /tts (text) or /sts (voice)
  └─ Avatar.jsx + Scenario.jsx  ←───  JSON with text, audio base64, lipsync, animation

Express backend (server.js)
  ├─ /tts → defaultMessages? → openAI.mjs → structured JSON (text, expression, animation)
  │           ↓
  │       lip-sync.mjs → elevenLabs.mjs TTS → rhubarb → base64 MP3 + mouthCues
  └─ /settings GET/POST  (reads/writes .env)

No database, no RAG, no multi-user sync, no vector store.
```

---

## 2. Repository Structure

| Path | Purpose | Subsystem | Notes |
|---|---|---|---|
| `run_app.sh` | Native startup helper | Infrastructure | Launches backend + frontend, handles cleanup |
| `package.json` (root) | `concurrently` orchestration | Infrastructure | `install:all`, `dev`, `build` |
| `docker-compose.yml` | Two-container compose | Deployment | `frontend` (5173) + `backend` (3000), bridge network |
| `Avatars/*.glb` | Source avatar assets (6 variants) | 3D assets | Not directly served; `public/models/ProfAbed_suit.glb` is the default runtime asset |
| `backend/server.js` | Express app, all routes | Backend core | Contains large blocks of commented legacy code |
| `backend/modules/openAI.mjs` | LangChain + OpenAI chain | AI | Prompt, Zod schema, structured output |
| `backend/modules/elevenLabs.mjs` | TTS client | Speech | Wraps `elevenlabs-node` |
| `backend/modules/lip-sync.mjs` | Orchestrates TTS + lip sync | Speech/Animation | Calls TTS, runs Rhubarb, base64 audio, validates timing |
| `backend/modules/rhubarbLipSync.mjs` | Rhubarb CLI invocation | Lip sync | `ffmpeg` to WAV, then `./bin/rhubarb -f json` |
| `backend/modules/whisper.mjs` | Legacy ASR placeholder | Speech | **Entire file is commented out** |
| `backend/modules/defaultMessages.mjs` | Fallback greetings / API-key warnings | AI fallback | Loads precomputed `audios/intro_*.wav` and `api_*.wav` |
| `backend/utils/files.mjs` | `execCommand`, JSON/base64 helpers | Utilities | Used by lip sync and default messages |
| `backend/utils/audios.mjs` | MP3 conversion helper | Utilities | **Not imported by active code** (legacy) |
| `backend/audios/*.{wav,json}` | Precomputed fallback audio + mouth cues | Speech/3D assets | `intro_0/1`, `api_0/1` |
| `backend/bin.zip` | Rhubarb binary + CMU Sphinx models | Lip sync toolchain | Must be unzipped to `backend/bin/` |
| `backend/env.template.txt` | Env template | Configuration | Required vars: `OPENAI_API_KEY`, `ELEVEN_LABS_API_KEY`, `ELEVEN_LABS_VOICE_ID`, `ELEVEN_LABS_MODEL_ID`, `OPENAI_MODEL` |
| `frontend/index.html` | Vite entry | UI | `title=Dtalk` |
| `frontend/src/main.jsx` | React mount, `SpeechProvider` | UI | Wraps `<App />` with speech context |
| `frontend/src/App.jsx` | Top-level layout | UI | Canvas + `Scenario` + UI controls |
| `frontend/src/components/Scenario.jsx` | 3D scene wrapper | 3D | `CameraControls`, `Environment`, `Avatar` |
| `frontend/src/components/Avatar.jsx` | Avatar rendering + lip-sync loop | 3D | Loads GLB + `animations.glb`, applies morph targets and animations |
| `frontend/src/components/ChatInterface.jsx` | Chat input + mic button | UI | Uses Web Speech API for transcription |
| `frontend/src/hooks/useSpeech.jsx` | Speech/audio state + backend calls | State/Networking | Queue of messages, `tts()`, recording helpers |
| `frontend/src/components/SettingsPanel.jsx` | Runtime API-key editor | UI / Security | `GET/POST /settings` |
| `frontend/src/components/AvatarFileSelector.jsx` | Local `.glb` picker | UI / 3D | Creates blob URL and swaps `currentAvatarPath` |
| `frontend/src/components/ContinuousRecorder.jsx` | Canvas video recorder | UI / Video | Auto-starts when a bot message is active; only download button visible |
| `frontend/src/constants/facialExpressions.js` | ARKit-style blendshape weights | 3D | Six presets: `default`, `smile`, `funnyFace`, `sad`, `surprised`, `angry`, `crazy` |
| `frontend/src/constants/visemesMapping.js` | Rhubarb A-H → ARKit viseme morph | 3D | `A`→`viseme_PP`, `B`→`viseme_kk`, etc. |
| `frontend/src/constants/morphTargets.js` | All known morph target names | 3D | 70+ ARKit-style blendshapes |
| `frontend/src/components/skeleton.js` | Skeleton debug logger | 3D | **Legacy/unused**; references `/models/ProfAbed_updated.glb` which does not exist in `public/models/` |

---

## 3. System Architecture

### Major components

#### 1. Browser/Web client
- **Responsibility:** Render 3D scene, capture user input, play audio, animate avatar.
- **Entry point:** `frontend/src/main.jsx` → `App.jsx`.
- **Key functions/classes:** `App`, `Scenario`, `Avatar`, `ChatInterface`, `useSpeech` hook.
- **Inputs:** user text, microphone events, `message` object from backend.
- **Outputs:** HTTP `POST /tts` (text) or `POST /sts` (voice, currently unreachable), UI state.
- **Dependencies:** React, Three.js, React Three Fiber, Web Speech API, `leva`.

#### 2. Avatar / 3D renderer
- **Responsibility:** Load GLB, load `animations.glb`, apply skeletal animations and blendshape morph targets for lip-sync/expression.
- **Entry point:** `frontend/src/components/Avatar.jsx`.
- **Key functions:** `Avatar()` component, `lerpMorphTarget()`, `useFrame()` loop.
- **Inputs:** `modelPath` (GLB), `message` (audio base64, `lipsync.mouthCues`, `facialExpression`, `animation`).
- **Outputs:** rendered WebGL scene, audio playback.
- **Dependencies:** `useGLTF`, `useAnimations`, `three`.

#### 3. Chat UI
- **Responsibility:** Text input, mic button, status messages.
- **Entry point:** `frontend/src/components/ChatInterface.jsx`.
- **Key functions:** `sendMessage()`, `handleMicPress()`, `handleMicRelease()`.
- **Inputs:** keyboard, mouse/touch/spacebar, browser speech transcript.
- **Outputs:** calls `useSpeech.tts()` or `useSpeech.transcribeAudio()`.

#### 4. Speech state service
- **Responsibility:** Manage recording, message queue, backend fetch, playback callbacks.
- **Entry point:** `frontend/src/hooks/useSpeech.jsx` → `SpeechProvider`.
- **Key functions:** `tts()`, `transcribeAudio()`, `startRecording()`, `stopRecording()`, `onMessagePlayed()`.
- **Inputs:** text or `message` object.
- **Outputs:** `message` state to `Avatar`, `loading`/`recording` to UI.
- **Dependencies:** `SpeechRecognition`, `MediaRecorder`, `fetch`.

#### 5. Backend API
- **Responsibility:** REST endpoints for TTS, STS, settings, voices.
- **Entry point:** `backend/server.js`.
- **Key functions:** `normalizeOpenAIResponse()`, `/tts`, `/sts`, `/settings`, `/voices`.
- **Inputs:** JSON payloads, `.env`.
- **Outputs:** JSON with `messages` array; `.env` mutation for `/settings`.
- **Dependencies:** Express, dotenv, modules below.

#### 6. LLM service
- **Responsibility:** Generate structured response text + animation + facial expression.
- **Entry point:** `backend/modules/openAI.mjs`.
- **Key classes/functions:** `ChatOpenAI`, `ChatPromptTemplate`, `StructuredOutputParser`, `openAIChain`.
- **Inputs:** `{ question, format_instructions }`.
- **Outputs:** `{ messages: [{ text, facialExpression, animation }] }`.
- **Dependencies:** OpenAI API via LangChain, Zod.

#### 7. TTS service
- **Responsibility:** Convert each `text` to MP3.
- **Entry point:** `backend/modules/elevenLabs.mjs`.
- **Key functions:** `initializeElevenLabs()`, `convertTextToSpeech()`.
- **Inputs:** `text`, output `fileName`.
- **Outputs:** MP3 file on disk.
- **Dependencies:** ElevenLabs Node SDK.

#### 8. Lip-sync / viseme service
- **Responsibility:** Run Rhubarb over TTS audio, build `mouthCues`, validate timing.
- **Entry point:** `backend/modules/lip-sync.mjs`.
- **Key functions:** `lipSync()`, `getPhonemes()`.
- **Inputs:** array of messages.
- **Outputs:** messages augmented with `audio` (base64 MP3) and `lipsync` (full Rhubarb JSON).
- **Dependencies:** FFmpeg, Rhubarb, `elevenLabs.mjs`.

#### 9. Default/fallback messages
- **Responsibility:** Return precomputed greetings or API-key warnings.
- **Entry point:** `backend/modules/defaultMessages.mjs`.
- **Key functions:** `sendDefaultMessages()`, `defaultResponse`.
- **Inputs:** userMessage, env vars.
- **Outputs:** messages with precomputed base64 `.wav` and `.json`.
- **Dependencies:** `utils/files.mjs`.

#### 10. Audio utilities
- **Responsibility:** Shell out to CLI, read JSON, base64-encode audio.
- **Entry point:** `backend/utils/files.mjs`.
- **Key functions:** `execCommand()`, `readJsonTranscript()`, `audioFileToBase64()`.
- **Dependencies:** `child_process`, `fs/promises`.

### Notable missing components
- **No RAG pipeline** — the system does no document retrieval.
- **No database / vector store** — state is React state plus disk files in `backend/audios/`.
- **No authentication / sessions** — endpoints are fully open.
- **No multi-user / WebSocket** — single-user HTTP request/response.
- **No dedicated ASR service** — Whisper module is commented out; the active path uses the browser’s Web Speech API.

### ASCII architecture diagram

```
+-----------------------+            HTTP POST            +------------------+
|   React / Vite /      |  /tts  {message}                |   Express        |
|   Three.js Client     | <-----------------------------> |   backend/       |
|   frontend/*          |                                 |   server.js      |
+----------+------------+            /settings            |   port 3000      |
           |                                /voices       +---------+--------+
           |                                                                      |
           |                                                +--------------------v--------------------+
           |                                                |  openAI.mjs  ->  OpenAI API (gpt-4)     |
           |                                                |  elevenLabs.mjs -> ElevenLabs TTS        |
           |                                                |  lip-sync.mjs -> Rhubarb / FFmpeg        |
           |                                                +--------------------+--------------------+
           |                                                                     |
           v                                                                     v
+----------+------------+   message = { text, audio, lipsync, facialExpression, animation }
|  Avatar.jsx           |<-------------------------------------------------------+
|  - useGLTF(model)     |
|  - useAnimations      |
|  - useFrame lip-sync  |
|  - Audio.play()       |
+-----------------------+
```

---

## 4. End-to-End Chat Flow

### Trace: user types text and gets avatar response

| Step | File / Function | Event / Call | Fields | Sync/Async | Failure behavior |
|---|---|---|---|---|---|
| 1. User types and presses Enter / clicks Send | `frontend/src/components/ChatInterface.jsx` `sendMessage()` | onClick/onKeyDown | `input.current.value` | sync | UI does nothing if `loading` or `message` |
| 2. `useSpeech.tts()` invoked | `frontend/src/hooks/useSpeech.jsx` `tts()` | `fetch('http://localhost:3000/tts')` | `JSON.stringify({ message: text })` | async | console.error, `loading=false` |
| 3. Backend receives request | `backend/server.js` `app.post('/tts')` | Express route | `req.body.message` | async | 500 with `Failed to process response` |
| 4. Empty/missing-key fallback? | `backend/modules/defaultMessages.mjs` `sendDefaultMessages()` | called in `/tts` | `userMessage`, env vars | async | Returns precomputed `intro_*` or `api_*` messages and short-circuits |
| 5. LLM call | `backend/modules/openAI.mjs` `openAIChain.invoke()` | OpenAI API | `{ question: userMessage, format_instructions }` | async | Caught, falls back to `defaultResponse` |
| 6. Response normalization | `backend/server.js` `normalizeOpenAIResponse()` | `Array.isArray`, `response.messages` checks | raw response | sync | Returns `{ messages: defaultResponse }` |
| 7. Lip sync/TTS generation | `backend/modules/lip-sync.mjs` `lipSync()` | `convertTextToSpeech()` then `getPhonemes()` then `readJsonTranscript()` | `messages[i].text` | async | Throws; 500 on failure |
| 8. Audio + base64 | `backend/utils/files.mjs` `audioFileToBase64()` | reads `audios/message_i.mp3` | base64 string | sync | 500 |
| 9. Response to client | `backend/server.js` `/tts` | `res.send({ messages: processedMessages })` | `{ messages: [{ text, audio, lipsync, facialExpression, animation }] }` | async | Generic 500 |
| 10. `useSpeech` message queue | `frontend/src/hooks/useSpeech.jsx` | `setMessages([...messages, ...response])` | `response.messages` | async | `console.error` |
| 11. `message` becomes active | `frontend/src/hooks/useSpeech.jsx` `useEffect` on `messages` | `setMessage(messages[0])` | first message | sync | — |
| 12. Avatar receives `message` | `frontend/src/components/Avatar.jsx` `useEffect` on `message` | `setAnimation`, `setFacialExpression`, `setLipsync`, `audio.play()` | `message.audio`, `message.lipsync.mouthCues`, `message.animation`, `message.facialExpression` | sync (play is async) | If `message` missing, reverts to `"Idle"` |
| 13. Lip-sync loop | `frontend/src/components/Avatar.jsx` `useFrame()` | each frame checks `audio.currentTime` against `lipsync.mouthCues` | `visemesMapping[mouthCue.value]` | sync per frame | — |
| 14. Animation playback | `frontend/src/components/Avatar.jsx` `useEffect` on `animation` | `actions[animation].reset().fadeIn().play()` | `animation` string | sync | Logs if missing, no visible action |
| 15. Message finished | `frontend/src/hooks/useSpeech.jsx` `onMessagePlayed()` | `audio.onended` | — | async | `messages.slice(1)`; queue shifts to next message |

---

## 5. API and Communication Layer

| Endpoint | Method | Caller | Handler | Input | Output | Purpose | Auth / Notes |
|---|---|---|---|---|---|---|---|
| `/tts` | `POST` | `ChatInterface.sendMessage()` | `backend/server.js` `app.post('/tts')` | `{ message: string }` | `{ messages: [{ text, audio: base64, lipsync: { mouthCues }, facialExpression, animation }] }` | Text → avatar speech+animation | No auth. `express.json({ limit: '50mb' })` |
| `/sts` | `POST` | `useSpeech.sendAudioData()` (unused/legacy in active frontend) | `backend/server.js` `app.post('/sts')` | `{ audio: base64 }` | same as `/tts` | Speech-to-text → response | **Broken in the active build**: `convertAudioToText` is not imported; the frontend now uses browser `webkitSpeechRecognition` and `/tts` |
| `/settings` | `GET` | `SettingsPanel` | `backend/server.js` `app.get('/settings')` | — | `{ openaiModel, openaiApiKey, elevenLabsApiKey, elevenLabsVoiceId, elevenLabsModelId }` | Expose current env | **Security issue**: returns raw API keys |
| `/settings` | `POST` | `SettingsPanel` form | `backend/server.js` `app.post('/settings')` | `{ openaiModel?, openaiApiKey?, ... }` | `{ message, settings }` | Overwrite `.env` and `process.env` | No auth, writes secrets to disk |
| `/voices` | `GET` | (currently unused) | `backend/server.js` `app.get('/voices')` | — | ElevenLabs voice list | List available voices | No auth |

### Frontend/backend contract

- The frontend expects `response.messages` as an array of objects with at least `text`, `audio` (base64 MP3), `lipsync` (object with `mouthCues`), `facialExpression`, and `animation`.
- `Avatar.jsx` reads `lipsync.mouthCues` and `message.audio`.
- `useSpeech` treats `messages` as a FIFO queue; `message` is always `messages[0]`.

---

## 6. Avatar System

### How the avatar model is loaded

- `Avatar.jsx` imports `useGLTF` and `useAnimations` from `@react-three/drei`.
- `const { nodes, materials } = useGLTF(modelPath);` loads the avatar GLB.
- `const { animations } = useGLTF(ANIMATIONS_PATH);` loads the bundled animation GLB.
- `modelPath` defaults to `'/models/ProfAbed_suit.glb'`; `AvatarFileSelector.jsx` can swap it via a blob URL.
- `useGLTF.preload(DEFAULT_AVATAR_PATH)` preloads the default.
- `useGLTF.dispose(previousModelPath.current)` is called when the path changes.

### Avatar format

- **GLB** format from **Avaturn** (as described in `README.md`). The repo includes six source GLBs under `Avatars/`, but the runtime copy is `frontend/public/models/ProfAbed_suit.glb`.
- There is also an `animations.glb` under `frontend/public/models/` that contains the animation library.
- The `skeleton.js` component refers to `/models/ProfAbed_updated.glb` which does **not** exist in the repository; that component is not mounted and is legacy.

### Skeleton / rig structure

- `Avatar.jsx` uses `nodes.Hips` as the root primitive: `<primitive object={nodes.Hips} />`.
- It then renders every `isMesh || isSkinnedMesh` from `nodes` as a `<skinnedMesh>` passing `geometry`, `material`, `skeleton`, and morph target dictionaries/influences.
- No manual bone manipulation is present. No retargeting logic. The assumption is that `animations.glb` and the avatar share a compatible Mixamo/Avaturn skeleton.

### Animation system

- **Mixer:** `useAnimations(animations, group)` returns `actions` and `mixer`.
- **Available animation names** (per prompt in `openAI.mjs` and FBX files in `public/animations/`): `Idle`, `TalkingOne`, `TalkingTwo`, `TalkingThree`, `SadIdle`, `Defeated`, `Angry`, `Surprised`, `DismissingGesture`, `ThoughtfulHeadShake`, `happy_idle`, `sad_idle`, etc. The exact set depends on `animations.glb`.
- **State management:** `animation` state is held in `Avatar` component.
- **Transition/blending:** `actions[animation].reset().fadeIn(mixer.stats.actions.inUse === 0 ? 0 : 0.5).play()`; cleanup `fadeOut(0.5)`.
- **Idle:** When `message` is falsy, `setAnimation("Idle")`.
- **Talking:** When a `message` is set, `setAnimation(message.animation)` (the LLM chooses the string).

### Facial expressions

- `facialExpressions.js` defines ARKit-style blendshape presets.
- `Avatar.jsx` maps `facialExpression` to the dictionary and applies each target weight in `useFrame` via `lerpMorphTarget(key, value, 0.1)`.
- Targets not in the current expression are lerped to `0`.
- **Blinking:** Independent `blink` state with random timeout (1–5 s); `eyeBlinkLeft` / `eyeBlinkRight` are set separately.

### How the avatar is positioned / spawned

- `Scenario.jsx` wraps the scene with `CameraControls` and `Environment preset="sunset"`.
- `Avatar` is placed at the origin implicitly; the camera is set with `cameraControls.current.setLookAt(0, 2.2, 5, 0, 1.0, 0, true)`.

### Interaction / proximity

- **None.** There is no click-on-avatar, proximity trigger, raycasting, or spatial interaction logic. The user interacts only through the chat bar / mic.

### Multiple avatars / NPCs

- **Not supported.** Only one `Avatar` component per `Scenario`. `AvatarFileSelector` can swap the model file locally, but only one is rendered at a time.

---

## 7. LLM / Chatbot Architecture

### Model / provider

- **OpenAI** via `langchain` and `@langchain/openai` SDK.
- **Model:** `process.env.OPENAI_MODEL || "gpt-4"` (default `gpt-4`).
- **API key:** `process.env.OPENAI_API_KEY || "-"`.

### Prompt / persona

- `backend/modules/openAI.mjs` defines a `template` string that sets the persona as **“Professor Abed, an intelligent and friendly AI assistant.”**
- It instructs the model to return a JSON object with a `messages` array of **maximum 3 messages**.
- Each message must contain `text`, `facialExpression`, and `animation`.
- Allowed values are explicitly enumerated:
  - `facialExpression`: `smile`, `sad`, `angry`, `surprised`, `funnyFace`, `default`.
  - `animation`: `Idle`, `TalkingOne`, `TalkingThree`, `SadIdle`, `Defeated`, `Angry`, `Surprised`, `DismissingGesture`, `ThoughtfulHeadShake` (note `TalkingTwo` is present in default messages but not in the prompt list).

### Structured output

- `StructuredOutputParser.fromZodSchema(z.object({ messages: z.array(z.object({ text, facialExpression, animation })) }))`.
- `parser.getFormatInstructions()` is injected into the prompt via `{format_instructions}`.
- The chain is `prompt.pipe(model).pipe(parser)`.

### Generation parameters

- `temperature: 0.2`.
- No `max_tokens`, `top_p`, `frequency_penalty`, etc. configured.
- No streaming; the response is awaited in full.

### Conversation history

- **There is no conversation history passed to the model.** Each `/tts` call sends only the current user message via `{ question: userMessage }`. The LLM is stateless.

### Intent / emotion classification

- **No separate classifier.** The LLM itself is asked to choose `facialExpression` and `animation` directly. This is effectively zero-shot classification through the structured output.

### Tool calling

- **None.**

### Guardrails / scope filtering / hallucination mitigation

- **None.** The only constraint is the persona and the enumerated allowed values in the prompt. No content moderation, no citations, no retrieval.

### Fallback responses

1. `defaultMessages.mjs` `sendDefaultMessages()`:
   - If `userMessage` is empty → intro greeting sequence.
   - If `OPENAI_API_KEY` or `ELEVEN_LABS_API_KEY` is missing → API-key reminder with precomputed audio.
2. `defaultResponse` in `defaultMessages.mjs`:
   - If the LLM chain throws → `“I’m sorry, there seems to be an error...”` with `sad` / `Idle`.
3. `server.js` final catch:
   - TTS/lip-sync failure → sad/Idle error message is lip-synced and sent.

### Error handling

- `normalizeOpenAIResponse()` tries to recover if the LLM returns an array directly or an object with a `messages` property.
- If the parser throws but `error.llmOutput` exists, the backend attempts `JSON.parse(error.llmOutput)` and, if it is an array, wraps it in `{ messages: [...] }`.
- If all parsing fails, `defaultResponse` is used.

### Logical sequence

```
userMessage
  ↓
sendDefaultMessages()?  → if empty/missing keys, return precomputed audio
  ↓
openAIChain.invoke({ question, format_instructions })
  ↓
normalizeOpenAIResponse()
  ↓
lipSync({ messages })
  ↓
res.send({ messages })
```

---

## 8. RAG / Knowledge System

**No RAG or knowledge-retrieval system exists in this repository.**

- There are no documents to ingest, no chunking, no embedding model, no vector database, no similarity search, no reranking, and no prompt augmentation with retrieved text.
- The model is prompted only with the persona and the current `question`.
- Course/domain restrictions are not enforced beyond the persona prompt and the allowed facial/animation enumerations.

---

## 9. Speech Pipeline

### ASR (active path)

The active speech path uses the **browser Web Speech API**, not the backend Whisper module.

| Step | File / Function | Details |
|---|---|---|
| Microphone permission | `useSpeech.jsx` `useEffect` on mount | `navigator.mediaDevices.getUserMedia({ audio: true })` |
| Start recognition | `transcribeAudio()` | Creates `SpeechRecognition` (or `webkitSpeechRecognition`), `lang='en-US'`, `continuous=false`, `interimResults=false` |
| Capture transcript | `recognition.onresult` | `event.results[0][0].transcript` |
| Stop recognition | `stopRecording()` | `recognition.stop()` |
| Send to chatbot | `ChatInterface.jsx` | Sets `input.current.value = transcript`; user must press Send to call `tts()` |

### ASR (backend / legacy)

- `backend/modules/whisper.mjs` is **completely commented out**.
- `backend/server.js` defines a `/sts` endpoint that calls `convertAudioToText`, but `convertAudioToText` is not imported. Calling `/sts` would throw a `ReferenceError`.
- The `useSpeech.jsx` `sendAudioData()` function still exists but is never invoked by the active UI.

### TTS

| Step | File / Function | Details |
|---|---|---|
| Text → MP3 | `backend/modules/elevenLabs.mjs` `convertTextToSpeech()` | Calls `voice.textToSpeech()` with `voiceId`, `modelId`, `stability=0.5`, `similarityBoost=0.5`, `style=1`, `speakerBoost=true` |
| Model | `process.env.ELEVEN_LABS_MODEL_ID` | Default `eleven_multilingual_v1` |
| Voice | `process.env.ELEVEN_LABS_VOICE_ID` | No default in template; must be supplied |
| Retries | `backend/modules/lip-sync.mjs` | `MAX_RETRIES=10`, `RETRY_DELAY=100ms`, exponential backoff only on `429` |
| Format | `audios/message_i.mp3` | MP3 on disk, then base64-embedded in JSON |
| Client playback | `Avatar.jsx` | `new Audio("data:audio/mp3;base64," + message.audio).play()` |

### Audio buffering / latency

- All audio is generated and lip-synced on the backend **before** the response is sent. There is no streaming. Latency is end-to-end: network + LLM + TTS + FFmpeg + Rhubarb.
- The client does not start playing until the full JSON has arrived and the audio element is constructed.

---

## 10. Lip-Sync System

### Technology

- **Rhubarb Lip Sync** (`./bin/rhubarb`) is the phoneme/viseme generator. It uses the included **CMU Sphinx** acoustic model and dictionary.
- **FFmpeg** converts the ElevenLabs MP3 to WAV before Rhubarb (Rhubarb requires WAV).

### Input

- `audios/message_${index}.mp3` (ElevenLabs TTS output).

### Processing

1. `lip-sync.mjs` calls `convertTextToSpeech()` for each message → MP3.
2. `rhubarbLipSync.mjs` runs:
   ```bash
   ffmpeg -y -i audios/message_${message}.mp3 audios/message_${message}.wav
   ./bin/rhubarb -f json -o audios/message_${message}.json audios/message_${message}.wav -r phonetic
   ```
   `-r phonetic` is used for speed over accuracy.
3. `lip-sync.mjs` reads `audios/message_${index}.json`, base64-encodes the MP3, and appends `lipsync` to the message.

### Output format

- Rhubarb JSON:
  ```json
  {
    "metadata": { "soundFile": "...", "duration": 1.51 },
    "mouthCues": [
      { "start": 0.0, "end": 0.01, "value": "X" },
      { "start": 0.01, "end": 0.06, "value": "A" },
      ...
    ]
  }
  ```
- `value` is one of: `A`, `B`, `C`, `D`, `E`, `F`, `G`, `H`, `X`.

### Viseme mapping

`frontend/src/constants/visemesMapping.js`:

```javascript
A: "viseme_PP"
B: "viseme_kk"
C: "viseme_I"
D: "viseme_AA"
E: "viseme_O"
F: "viseme_U"
G: "viseme_FF"
H: "viseme_TH"
X: "viseme_PP"   // rest/neutral
```

### Timing synchronization

- `Avatar.jsx` `useFrame` reads `audio.currentTime`.
- It iterates `lipsync.mouthCues` and finds the cue whose `start <= currentTime <= end`.
- That single viseme morph target is set to `1` via `lerpMorphTarget(..., 1, 0.2)`; all others are lerped to `0`.
- `lip-sync.mjs` additionally pads the last cue to the real audio duration if `lastEntry.end < audioDuration`.

### Which component applies mouth shapes

- `frontend/src/components/Avatar.jsx` in the `useFrame` loop.
- It applies the value to **all** `SkinnedMesh` nodes that have a matching `morphTargetDictionary` entry.

### Important limitation

- Only **one viseme is active at a time**; there is no co-articulation or blending of multiple visemes. This is a limitation of the Rhubarb A-H discrete model and the simple “first match” logic.

---

## 11. Emotion and Animation Pipeline

### How emotional/behavioral states are determined

The **LLM directly emits** the `facialExpression` and `animation` strings as part of its structured output. There is no separate emotion classifier, keyword rules, or state machine.

### Available states

- **Facial expressions:** `default`, `smile`, `sad`, `angry`, `surprised`, `funnyFace`, `crazy` (frontend has `crazy`; backend prompt omits it).
- **Animations:** the set in `animations.glb`; the prompt restricts to `Idle`, `TalkingOne`, `TalkingThree`, `SadIdle`, `Defeated`, `Angry`, `Surprised`, `DismissingGesture`, `ThoughtfulHeadShake`. The default/fallback also uses `TalkingTwo`.

### State reach

```
openAI.mjs  →  response.messages[i].facialExpression / .animation
                ↓
server.js res.send({ messages })
                ↓
useSpeech.jsx  →  setMessages / message state
                ↓
Avatar.jsx     →  setFacialExpression(message.facialExpression)
                 setAnimation(message.animation)
```

### Rendering

- `useEffect([animation])` plays the animation clip.
- `useFrame` continuously applies the `facialExpression` blendshape weights and the current lip-sync viseme.
- When the audio finishes, `onMessagePlayed` removes the message; the avatar reverts to `Idle` and default expression (all morph targets → 0).

---

## 12. Frontend Architecture

### Main entry point

- `frontend/index.html` loads `src/main.jsx`.
- `frontend/src/main.jsx` mounts the React app and wraps it with `SpeechProvider`.
- `frontend/src/App.jsx` composes the UI and the 3D canvas.

### Scene / world initialization

- `Scenario.jsx` creates a `Canvas` in `App.jsx` with a `CameraControls`, `Environment preset="sunset"`, and the `Avatar`.

### Important components

| Component | Responsibility |
|---|---|
| `App.jsx` | Root layout; manages `currentAvatarPath` state; passes to `Scenario`. |
| `Scenario.jsx` | 3D scene wrapper, camera positioning. |
| `Avatar.jsx` | GLB loading, animation mixer, blendshape application, lip-sync, audio playback. |
| `ChatInterface.jsx` | Text input, mic button, status text, Enter/Space/mouse/touch handlers. |
| `AvatarFileSelector.jsx` | File picker for local `.glb` swaps. |
| `SettingsPanel.jsx` | Read/write backend `.env` via `/settings`. |
| `ContinuousRecorder.jsx` | Auto-records the canvas to a downloadable WebM/MP4 while a message is playing. |

### Global state

- `useSpeech.jsx` `SpeechContext` is the only global state store. It holds:
  - `messages` queue
  - `message` currently playing
  - `loading`, `recording`, `isListening`
  - `micPermissionGranted`, `speechSupported`
  - `tts()`, `transcribeAudio()`, `startRecording()`, `stopRecording()`, `onMessagePlayed()`

### How UI state and avatar state are connected

- `Avatar` consumes `message` from `useSpeech`.
- `ChatInterface` consumes `loading`, `message`, `recording`, `isListening`, `speechSupported`, `tts`, `start/stopRecording`, `transcribeAudio`.
- When `message` changes, `Avatar` triggers audio, animation, and lip-sync.
- When `message` ends, `onMessagePlayed` advances the queue, which updates `message` again.

### Networking layer

- Direct `fetch` calls in `useSpeech.jsx` (backend URL hardcoded to `http://localhost:3000`) and `SettingsPanel.jsx` / `ChatInterface.jsx`.

### No global state library

- No Redux, Zustand, MobX, etc. Only React Context in `useSpeech`.

---

## 13. Backend Architecture

### Main entry point

- `backend/server.js` — `dotenv.config()`, `express()` setup, routes, `app.listen(3000)`.

### Framework

- Express 4 with `cors()` and `express.json({ limit: '50mb' })`.

### Routes / controllers

All in `server.js`:

- `GET /settings`
- `POST /settings`
- `POST /tts`
- `POST /sts`
- `GET /voices`

There is no `routes/` directory, no controller layer.

### Service layer

All in `backend/modules/`:

- `openAI.mjs`
- `elevenLabs.mjs`
- `lip-sync.mjs`
- `rhubarbLipSync.mjs`
- `defaultMessages.mjs`
- `whisper.mjs` (dead code)

### Utilities

- `backend/utils/files.mjs` — shell, JSON, base64.
- `backend/utils/audios.mjs` — MP3 conversion (legacy, not imported).

### Configuration

- `dotenv` loads `backend/.env`. `env.template.txt` is the user-facing template.

### Dependency flow

```
server.js
  ├─ openAI.mjs ── ChatOpenAI (OpenAI API)
  ├─ lip-sync.mjs ─┬─ elevenLabs.mjs ── ElevenLabs API
  │                └─ rhubarbLipSync.mjs ── ffmpeg / ./bin/rhubarb
  ├─ defaultMessages.mjs ── utils/files.mjs
  └─ utils/files.mjs
```

---

## 14. Runtime and Deployment

### Docker

- `docker-compose.yml` defines two services on a bridge network `app-network`.
- `frontend/Dockerfile`: `node:18-alpine`, `yarn install`, `yarn dev --host`, exposes 5173. Note: it references `yarn.lock` which is deleted in the working tree; the build will fail if `yarn.lock` is not restored. The project uses `npm`/`package-lock.json` elsewhere.
- `backend/Dockerfile`: `node:18-slim`, installs `ffmpeg unzip`, copies and unzips `bin`, `yarn install` (same `yarn.lock` issue), exposes 3000.

### Native

- `run_app.sh` installs with `npm` if `node_modules` is missing, then runs `npm --prefix backend run dev` and `npm --prefix frontend run dev`.

### Service table

| Service | Role | Port | Depends On | Runtime |
|---|---|---|---|---|
| `frontend` (Vite) | React/Three.js app | 5173 | — | Node 18, Vite |
| `backend` (Express) | API, TTS, lip sync, LLM | 3000 | `bin/` extracted, `ffmpeg` installed, `.env` file | Node 18 |
| `Rhubarb` | Lip-sync binary | — | `backend` | Native binary in `backend/bin/` |
| `OpenAI` | LLM inference | 443 (HTTPS) | `backend` | External API |
| `ElevenLabs` | TTS | 443 (HTTPS) | `backend` | External API |

### Startup order

1. Extract `backend/bin.zip` to `backend/bin/` and `chmod +x bin/rhubarb` (manual step in README).
2. Create `backend/.env` from `env.template.txt` and fill API keys.
3. `npm install` (or `docker-compose build`) for both frontend and backend.
4. Start backend (so `audios/` directory exists, `.env` loaded, Rhubarb ready).
5. Start frontend.
6. Docker: Compose will build and start both; `frontend` depends on nothing in code but obviously needs `backend` reachable at `http://localhost:3000`.

### GPU

- No GPU requirement in application code. No `cuda`, no local model server. ElevenLabs and OpenAI are cloud.

---

## 15. Configuration

| Variable | Purpose | Default | Consumed in | Required? |
|---|---|---|---|---|
| `OPENAI_MODEL` | OpenAI chat model | `gpt-4` | `backend/modules/openAI.mjs`, `backend/server.js` /settings | Optional (falls back) |
| `OPENAI_API_KEY` | OpenAI API key | none | `backend/modules/openAI.mjs` | Required for real chat |
| `ELEVEN_LABS_API_KEY` | ElevenLabs API key | none | `backend/modules/elevenLabs.mjs` | Required for TTS |
| `ELEVEN_LABS_VOICE_ID` | ElevenLabs voice ID | none | `backend/modules/elevenLabs.mjs` | Required for TTS |
| `ELEVEN_LABS_MODEL_ID` | ElevenLabs TTS model | `eleven_multilingual_v1` | `backend/modules/elevenLabs.mjs` | Required (has default) |
| `PORT` | (implicit) | 3000 hardcoded | `backend/server.js` | No (hardcoded) |

### Other configuration

- `backendUrl` is hardcoded to `http://localhost:3000` in `frontend/src/hooks/useSpeech.jsx` and `frontend/src/components/SettingsPanel.jsx`.
- Vite server host/port in `frontend/vite.config.js`: `host: '0.0.0.0'`, `port: 5173`.
- `docker-compose.yml` sets `VITE_API_URL=http://localhost:5000` but the frontend code does not read `VITE_API_URL`; this variable is unused.

---

## 16. Data Models and State

| State | What it holds | Where it lives | Modified by |
|---|---|---|---|
| User message queue | `messages` array of bot responses | `useSpeech.jsx` `SpeechContext` | `tts()` fetch success, `onMessagePlayed()` |
| Currently playing message | `message` (first in queue) | `useSpeech.jsx` | `useEffect` on `messages` |
| Loading state | `loading` boolean | `useSpeech.jsx` | `tts()` start/finish |
| Recording state | `recording`, `isListening` booleans | `useSpeech.jsx` | `startRecording()`, `stopRecording()`, `transcribeAudio()` |
| Transcript | `currentTranscriptionRef` | `ChatInterface.jsx` | `transcribeAudio()` promise |
| Avatar model path | `currentAvatarPath` | `App.jsx` | `AvatarFileSelector` |
| Avatar animation | `animation` string | `Avatar.jsx` local state | `useEffect` on `message` |
| Facial expression | `facialExpression` string | `Avatar.jsx` local state | `useEffect` on `message` |
| Lip-sync data | `lipsync` object | `Avatar.jsx` local state | `useEffect` on `message` |
| Audio playback | `audio` `HTMLAudioElement` | `Avatar.jsx` local state | `useEffect` on `message` |
| API settings | `settings` form values | `SettingsPanel.jsx` | user input, `GET /settings` |
| `.env` file | API secrets | disk (`backend/.env`) | `POST /settings` |

No server-side session or user state is maintained.

---

## 17. Multi-User / Networking Behaviour

**The platform is strictly single-user.** No multi-user networking exists.

- No rooms, sessions, presence, broadcast, shared objects, or conflict handling.
- No WebSocket, WebRTC, or socket.io.
- The `SpeechContext` is per-browser; there is no synchronization.
- `@react-three/xr` is a dependency but not used for any networked XR or multi-user experience in the active code.

---

## 18. Dependencies

### Core application

- `react`, `react-dom`
- `three`, `@react-three/fiber`, `@react-three/drei`, `@react-three/xr`
- `leva`, `lucide-react`
- `express`, `cors`, `dotenv`
- `concurrently`

### AI/ML

- `openai`
- `langchain`, `@langchain/openai`
- `zod`

### 3D / WebXR / avatar

- `three` 0.160.0
- `@react-three/drei` 9.93.0
- `@react-three/fiber` 8.15.13
- `@react-three/xr` ^5.7.1 — **declared but not used** in active components.
- `@types/three`

### Speech / audio

- `elevenlabs-node` — TTS
- `ffmpeg` — system dependency
- Rhubarb binary — lip sync

### Networking / build

- `vite`, `@vitejs/plugin-react`
- `tailwindcss`, `postcss`, `autoprefixer`

### Infrastructure / tooling

- `nodemon`
- `concurrently`

### Flags

- **`@react-three/xr`**: included in `package.json` but not imported or used.
- **`backend/utils/audios.mjs`**: no active import; legacy from an earlier Whisper pipeline.
- **`backend/modules/whisper.mjs`**: fully commented out; `convertAudioToText` is not exported.
- **`frontend/src/components/skeleton.js`**: not mounted, references missing GLB.
- **Dockerfiles reference `yarn.lock`**: `yarn.lock` is deleted in the working tree; builds must use `package-lock.json`/`npm` instead.

---

## 19. Code Quality and Technical Debt

| Issue | Evidence | Impact | Recommended Fix |
|---|---|---|---|
| **Critical: `/settings` endpoint leaks API keys** | `backend/server.js` `GET /settings` returns `openaiApiKey` and `elevenLabsApiKey` | Anyone with network access can read secrets | Never return keys; return only non-sensitive config or use a secure config store / masked display |
| **`/settings` POST overwrites `.env` without validation or auth** | `backend/server.js` `app.post('/settings')` writes `process.env.OPENAI_API_KEY` and `.env` from untrusted input | Unauthenticated remote file/environment mutation | Add auth, validate input, do not write `.env` from HTTP; use in-memory config or secrets manager |
| **`/sts` endpoint is broken** | `backend/server.js` uses `convertAudioToText` but the import is commented out and `whisper.mjs` is entirely commented | Calling `/sts` throws `ReferenceError` | Either remove `/sts` or re-implement and import `convertAudioToText` with a real Whisper/OpenAI integration |
| **`docker-compose.yml` `VITE_API_URL` is unused** | `VITE_API_URL=http://localhost:5000` is set, but frontend hardcodes `http://localhost:3000` | Misleading config, non-functional reverse-proxy setup | Use `import.meta.env.VITE_API_URL` in `useSpeech` and `SettingsPanel`, or remove the variable |
| **Hardcoded backend URL** | `http://localhost:3000` appears in `useSpeech.jsx` and `SettingsPanel.jsx` | Deployment to other hosts/ports fails | Centralize in an environment variable or Vite config |
| **No conversation history** | `openAI.mjs` only sends `{ question }` | The “professor” cannot maintain context | Add a `messages` array parameter to the prompt or use a chat model with history |
| **No input validation / rate limiting** | Express accepts any JSON on `/tts` and `/settings` | Potential abuse, large-payload DoS, secret exfiltration | Add `express-rate-limit`, input size/validation, auth |
| **Synchronous file I/O via shell commands** | `lip-sync.mjs` uses `child_process.exec` and `fs/promises` sequentially for each message | Blocking-ish per-request, not scalable | Use streaming/concurrent pipelines where safe, or queue TTS jobs |
| **Race conditions in message queue** | `useSpeech.jsx` `onMessagePlayed` does `setMessages(messages => messages.slice(1))` but `audio.onended` is async; multiple rapid messages may overlap | Possible desync between audio and queue | Ensure one active audio at a time, clear audio before next |
| **Missing error UX** | `ChatInterface` catches only `console.error`; no user-facing error feedback | Users see “Loading...” forever on failure | Add error state and display fallback messages |
| **No tests** | No `*.test.*` or `*.spec.*` files; no `tests/` or `__tests__/` | Regressions not caught | Add unit tests for modules, integration tests for `/tts`, component tests for `Avatar` |
| **Dead/commented code throughout** | `backend/server.js` contains 450+ lines of commented code; `whisper.mjs` fully commented | Clutter, confusion, larger bundle/review surface | Delete or move to git history |
| **`yarn.lock` missing; Dockerfiles still reference it** | `git status` shows `D backend/yarn.lock`, `D frontend/yarn.lock` | Docker `COPY` will fail | Switch Dockerfiles to `package*.json` and `npm ci` |
| **Animation prompt mismatch** | `openAI.mjs` allows `TalkingOne`, `TalkingThree`, but default messages use `TalkingTwo`; `TalkingTwo` is not in prompt list | LLM may not choose `TalkingTwo`, causing missing fallback | Add `TalkingTwo` to the allowed list or remove it from defaults |
| **Rhubarb `-r phonetic` reduced accuracy** | `rhubarbLipSync.mjs` uses `-r phonetic` for speed | Lower lip-sync quality | Use default recognition mode if latency allows |

---

## 20. Performance / Latency Analysis

### Latency-critical parts

The pipeline is entirely **synchronous per request** on the backend and **blocking before response**.

1. **Network round-trip** (client → backend)
2. **LLM inference** (OpenAI `gpt-4`, non-streamed)
3. **TTS** (ElevenLabs, multiple messages)
4. **FFmpeg** MP3→WAV conversion
5. **Rhubarb** phoneme/viseme generation
6. **Base64 encoding** of MP3
7. **JSON download** to client
8. **Audio decode/start** in browser

### Sequential operations that could be streamed or parallelized

- **TTS and lip-sync** are currently done in two sequential passes: `Promise.all` for TTS, then `Promise.all` for lip-sync. TTS + lip-sync per message could be chained, but the per-message conversion has to finish before lip-sync can begin.
- **Audio generation** could stream from ElevenLabs directly to the client to reduce TTFB.
- **LLM and TTS** cannot start in parallel because TTS needs the LLM text, but once the first sentence is generated from an LLM streaming response, TTS could begin for that sentence.
- **MP3 → WAV → Rhubarb** must remain sequential for a given file.
- **Multiple messages** are processed in parallel with `Promise.all`, which is good.

### GPU

- No local GPU. The system is I/O and API-call bound. The most expensive latencies are external API calls.

### Scalability bottlenecks

- Each request spawns FFmpeg and Rhubarb as `child_process`. Heavy concurrent load will exhaust CPU and disk I/O quickly.
- Files are written to `backend/audios/` with predictable names (`message_0`, `message_1`), which **will collide** under concurrent requests. No session-specific or UUID-based filenames.

---

## 21. Security Review

### Findings

| # | Finding | Severity | Evidence |
|---|---|---|---|
| 1 | **Exposed API keys via `/settings` GET** | Critical | `backend/server.js` lines 483-497 return `openaiApiKey`, `elevenLabsApiKey` |
| 2 | **Unauthenticated `/settings` POST writes `.env`** | Critical | `backend/server.js` lines 500-555 writes arbitrary input to disk and `process.env` |
| 3 | **CORS wide open** | High | `app.use(cors())` in `backend/server.js` line 460 |
| 4 | **No input validation on `/tts` or `/settings`** | High | `req.body.message` used directly; settings fields used directly |
| 5 | **Command injection risk in `execCommand`** | High | `backend/utils/files.mjs` passes arbitrary command strings from callers; `lip-sync.mjs` interpolates filenames into `execAsync`; if user-controlled text reaches filenames, shell metacharacters could be injected. Currently filenames are hardcoded `message_${index}`, but `ffprobe` command uses `fileName` from `lip-sync.mjs` derived from index, not user input. The pattern is still risky. |
| 6 | **No rate limiting / DoS** | Medium | Large `express.json({ limit: '50mb' })`, no rate limiting, `/tts` does expensive external calls |
| 7 | **Client-side speech recognition sends transcript to backend** | Low | Web Speech API transcript is sent via `/tts`; this is acceptable but no sanitization |
| 8 | **Hardcoded `http://localhost:3000`** | Low | Cannot run in production, mixed-content issues |
| 9 | **No HTTPS/TLS** | Medium | Only HTTP dev servers; cloud APIs use HTTPS but app itself is plain text |

### Missing / disabled legacy features

- The commented-out `/transcribe` and `whisper.mjs` suggest an earlier intent to use OpenAI Whisper, but it is not active, so no Whisper security analysis applies.

---

## 22. Tests and Evaluation

### Existing tests

**None found.** There are no unit, integration, end-to-end, AI evaluation, RAG benchmark, or latency benchmark files in the repository (excluding the `bin/` test resources for the Rhubarb binary itself).

### Important uncovered areas

- LLM output parsing and `normalizeOpenAIResponse` edge cases.
- ElevenLabs TTS failure / 429 retry behavior.
- Rhubarb/FFmpeg missing dependency handling.
- `Avatar.jsx` animation fallback when an LLM returns an unknown animation name.
- Audio playback on different browsers and Web Speech API support.
- `/settings` endpoint security.
- Docker build success with missing `yarn.lock`.
- Concurrent request filename collisions.

---

## 23. Important Execution Traces

### Trace A — Text chat

```
frontend/src/components/ChatInterface.jsx::sendMessage()
  → input.current.value
  → frontend/src/hooks/useSpeech.jsx::tts(text)
    → fetch POST http://localhost:3000/tts { message: text }
    → backend/server.js::app.post('/tts')
      → backend/modules/defaultMessages.mjs::sendDefaultMessages()  (empty/missing keys)
        → if not, backend/modules/openAI.mjs::openAIChain.invoke({ question, format_instructions })
          → backend/server.js::normalizeOpenAIResponse()
            → backend/modules/lip-sync.mjs::lipSync({ messages })
              → backend/modules/elevenLabs.mjs::convertTextToSpeech()
              → backend/modules/rhubarbLipSync.mjs::getPhonemes()
              → backend/utils/files.mjs::readJsonTranscript(), audioFileToBase64()
      → res.send({ messages: [...] })
  → useSpeech setMessages / setMessage
  → frontend/src/components/Avatar.jsx::useEffect([message])
    → setAnimation(), setFacialExpression(), setLipsync()
    → new Audio("data:audio/mp3;base64," + message.audio).play()
    → useFrame() lip-sync loop against audio.currentTime
  → audio.onended → useSpeech::onMessagePlayed() → messages.slice(1)
```

### Trace B — Voice interaction (active frontend path)

```
User holds mic button / Spacebar
  → frontend/src/components/ChatInterface.jsx::handleMicPress()
    → setIsPressed(true), startRecording()
    → frontend/src/hooks/useSpeech.jsx::transcribeAudio()
      → window.SpeechRecognition (webkitSpeechRecognition)
      → recognition.lang = 'en-US'
      → recognition.start()
  User releases
    → stopRecording()
    → recognition.stop()
    → transcript resolves in ChatInterface
    → input.current.value = transcript
  User presses Enter/Send
    → tts(transcript) → Trace A
```

### Trace C — Avatar animation

```
backend/modules/openAI.mjs (LLM returns messages[i].animation and .facialExpression)
  ↓
backend/server.js res.send({ messages })
  ↓
frontend/src/hooks/useSpeech.jsx setMessages / setMessage
  ↓
frontend/src/components/Avatar.jsx useEffect([message])
  setAnimation(message.animation)         // e.g. "TalkingOne"
  setFacialExpression(message.facialExpression)  // e.g. "smile"
  setLipsync(message.lipsync)
  ↓
frontend/src/components/Avatar.jsx useEffect([animation])
  actions[animation].reset().fadeIn(0.5).play()
  ↓
frontend/src/components/Avatar.jsx useFrame()
  for morphTargets: lerpMorphTarget(target, facialExpression[target])
  for audio.currentTime: lerpMorphTarget(visemesMapping[mouthCue.value], 1)
```

---

## Appendix: Quick Reference — Key Files

| Purpose | Path |
|---|---|
| Backend entry | `backend/server.js` |
| LLM chain | `backend/modules/openAI.mjs` |
| TTS | `backend/modules/elevenLabs.mjs` |
| Lip sync | `backend/modules/lip-sync.mjs` |
| Rhubarb runner | `backend/modules/rhubarbLipSync.mjs` |
| Fallback messages | `backend/modules/defaultMessages.mjs` |
| Frontend entry | `frontend/src/main.jsx` |
| Top component | `frontend/src/App.jsx` |
| Avatar render | `frontend/src/components/Avatar.jsx` |
| Scene wrapper | `frontend/src/components/Scenario.jsx` |
| Speech state | `frontend/src/hooks/useSpeech.jsx` |
| Chat UI | `frontend/src/components/ChatInterface.jsx` |
| Expression weights | `frontend/src/constants/facialExpressions.js` |
| Viseme map | `frontend/src/constants/visemesMapping.js` |
| Morph target list | `frontend/src/constants/morphTargets.js` |
| Deployment | `docker-compose.yml`, `backend/Dockerfile`, `frontend/Dockerfile` |

---

**End of report.**
