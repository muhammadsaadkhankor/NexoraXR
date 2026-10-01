# NexoraXR — Workspace Review & Progress Summary

A code-review style overview of the entire project: what has been built, how each
component works, and what issues remain. NexoraXR is a **3D virtual classroom**
where an AI professor ("Professor Abed") delivers lectures with synthesized speech,
lip-sync and animations to multiple students who share a room in real time.

---

## 1. High-Level Architecture

Four runtime services:

| Service | Tech | Port | Launch |
|---|---|---|---|
| Frontend | React 18 + Vite + react-three-fiber + Tailwind | 5173 | `npm run dev:frontend` |
| Backend | Node 18 + Express + Socket.IO | 3000 | `npm run dev:backend` |
| CosyVoice TTS | Python FastAPI + CosyVoice2-0.5B | 5000 | `cosyvoice_tts.sh` (conda env `cosyvoice`) |
| Ollama LLM | `qwen2.5:7b` (runtime), `qwen2.5:1.5b` (offline prep) | 11434 | external |

**End-to-end teaching flow:**

1. Student picks a course on the landing page → `/course/:courseId` → picks a
   lecture → `/scene/:sceneName?lecture=…`.
2. Enters a display name (sessionStorage) → socket `join` → avatar spawns in the
   3D classroom; other students appear as remote avatars.
3. **Start Class** → `GET /api/lecture/segments/:id` → backend returns segments
   `{text, audioUrl, animation, facialExpression, lipsync}` → pushed into the
   speech queue → the professor avatar plays audio + Rhubarb lipsync + GLB
   animation sequentially.
4. Every played message is broadcast via `professor-speak` so all room members
   hear the professor in sync.
5. **Floor system**: raise hand → grant floor → lecture pauses room-wide →
   student asks a question → `/api/ask` (Ollama + CosyVoice + Rhubarb, MD5-cached)
   → answer broadcast → release floor → lecture resumes.

---

## 2. Frontend (`src/frontend`)

Stack: `react-router-dom` 7, `@react-three/fiber` 8.15, `drei` 9.93, `three`
0.160, `socket.io-client` 4.8, Tailwind, `lucide-react`. Vite proxies
`/socket.io` to `:3000`.

### 2.1 Routing — `main.jsx`, `App.jsx`

`BrowserRouter` → `SpeechProvider` → routes:

- `/` → `LandingPage` (marketing sections in `src/landing/`)
- `/course/:courseId` → `CoursePage` (fetches `/api/lectures`, lecture picker)
- `/scene/:sceneName` → `Scene` (the classroom)
- `*` → redirect `/`

### 2.2 `Scene.jsx` — page orchestrator (~960 lines)

Sub-components:

- **`NameEntryModal`** — display-name gate; persists to
  `sessionStorage['nexoraxr_display_name']`; on `join-error` the name is cleared
  and the modal re-shows.
- **`LoadingOverlay`** — spinner until `Scenario` fires `onReady`.
- **`AvatarPicker` / `AvatarPreview`** — modal grid where each of the 9 student
  avatars renders live in its own R3F canvas (auto-fit via `Box3`, spinning).
  Now has an **X close button** so the menu can be dismissed without selecting.
- **`ClassroomPanel`** — recently **restyled to a top-center floating pill
  toolbar** (`fixed left-1/2 top-4 -translate-x-1/2`, rounded-full, dark
  glassmorphism, cyan accents) matching the VR-style reference image:
  - Course/lecture label (Globe icon)
  - **Camera** pill showing current preset ("Third Person" / "First Person")
  - **Raise Hand** dropdown (cyan-outlined): *Raise Hand — let the instructor
    know*, *Request to Speak — add to speaking queue*, *Lower Hand / Release
    Floor — cancel request*; each row has a radio-dot state indicator. Footer
    shows the **Active Speaker**, the waiting queue, and a **Grant Next** button.
  - **Avatar** dropdown (professor outfit picker: Suit, Arab Dress, Black
    T-Shirt, Soccer, VR, Prof Ralf)
  - **My Avatar** (opens AvatarPicker), **Chat**, **Settings**
  - **Start Class** cyan pill — label follows `lectureStatus`:
    Start / Loading Lecture / Class in Progress / Replay / Retry.
  - Backdrop overlay closes dropdowns; error banner floats below the bar.
- **`Scene`** — config merge (`SCENE_CONFIG` + runtime
  `scenes/configs/*.json` via `import.meta.glob`), all state (players, floor
  queue, lecture status, joystick ref), socket client, and the R3F `<Canvas>`.

### 2.3 Socket client (in `Scene.jsx`)

Connects to `http://localhost:3000`. Events:

| Event | Direction | Purpose |
|---|---|---|
| `join` | emit | `{roomId, name, avatar, position, rotation, animation}` |
| `room-state` / `user-joined` / `state-update` / `user-left` | receive | remote player map |
| `professor-speak` | both | professor speech sync; `floorAnswer` items are *prepended* |
| `lecture-control` | receive | `pause-for-floor` / `resume` / `answering` / `answer-error` |
| `floor-state` | receive | `{floorQueue, activeSpeaker}` |
| `request-floor` / `cancel-floor-request` / `grant-floor` / `release-floor` | emit | raise-hand system |
| `ask-floor-question` | emit | floor-holder Q&A (500-char cap) |
| `join-error` / `disconnect` | receive | name re-prompt / state reset |

Outbound `professor-speak` is deduped by message id
(`lastEmittedMessageIdRef`).

### 2.4 3D components (`src/components/`)

- **`Scenario.jsx`** — loads the classroom GLB, `<Environment preset>`,
  `CameraControls` (manual; `C` key toggles first/third person), glowing
  `AuraZone` torus under the professor (raycast placement), `LectureSlide`
  plane that textures `/api/lecture/pdf_image/:id` onto the classroom screen
  node (with error boundary + placeholder), proximity check
  (`TALK_RADIUS = 2`) that opens chat when near the professor.
- **`Avatar.jsx`** (professor) — merges avatar GLB clips with
  `models/animations.glb`; per message: picks animation via `ANIMATION_MAP`,
  plays `audioUrl`/base64 audio, honors `resumeAt` for pause/resume, per-frame
  lerps facial-expression morph targets, random blinking, and Rhubarb lipsync
  (`visemesMapping` → mouth morphs vs `audio.currentTime`).
- **`UserAvatar.jsx`** — local player: arrow keys + Shift run + joystick +
  pointer-drag mouselook; wall raycast clamps (`WALL_MARGIN`), floor
  dual-raycast smoothing (`MAX_STEP_DELTA`), directional walk/run animation
  blending, throttled (~90 ms, ≥0.05 delta) `state-update` emits; hidden in
  first-person.
- **`RemoteAvatar.jsx`** — remote players: cache-busted GLB instance, snapshot
  interpolation buffer (60–400 ms lerp), shortest-arc yaw, `✋ name` nametag.
- **`ChatInterface.jsx`** — bottom sheet with chat history, "Now speaking"
  karaoke bubble (`SpeakingTranscript` — word-by-word sync to audio time),
  hold-to-talk mic (Web Speech API), floor-aware send routing
  (`ask-floor-question` vs `askQuestion` vs `/tts`).
- **`SettingsPanel.jsx`** — modal that GET/POSTs `/settings` (OpenAI /
  ElevenLabs keys — legacy services).
- **`ContinuousRecorder.jsx`** — auto-records canvas + audio to WebM/MP4 with a
  Download button (see issues: uses its own audio element).
- **`Joystick.jsx`** — touch joystick writing into shared `joystick` ref.

### 2.5 `useSpeech` hook (`src/hooks/useSpeech.jsx`)

`SpeechProvider` context owning the message queue: `pushMessage`,
`prependMessages` (floor answers), `onMessagePlayed` (dequeue),
`transcribeAudio`/`startRecording`/`stopRecording` (Web Speech API),
`pauseLectureForFloor`/`resumeLecture` (stamp `resumeAt` on the shared
`audioElementRef`), `askQuestion` (`POST /api/ask` → prepend), `tts`, and
`clearMessages`.

### 2.6 Constants & services

- `constants/` — `visemesMapping`, `morphTargets`, `facialExpressions`,
  `lectureDetails` (Lecture_1..8 subtitles/questions).
- `services/lectureApi.js` — `getLectures`, `explainLecture`, `audioUrl`.
- `sceneConfig.js` — per-course scene definitions (Multimedia uses `scene.glb`
  + sunset; ELG5121/CS401/MED320/BIO210/MTH150/VR101 use
  `modified-classroom.glb` with various env presets). `scenes/configs/` JSONs
  override spawn/transform/bounds at runtime (only `ELG5121.json` exists).

---

## 3. Backend (`src/backend`)

### 3.1 `server.js` (~954 lines, ~half commented legacy)

Express + Socket.IO on `:3000`, CORS open, mounts `lectureRouter` at `/api`.

REST: `GET/POST /settings` (rewrites `.env`), `POST /tts` (**legacy
OpenAI+ElevenLabs path**), `GET /voices`, `POST /sts` (**broken** — see issues).

Socket.IO room state is in-memory: `rooms`, `socketRoom`, and
`socialStates[roomId] = {floorQueue, activeSpeaker, lecturePaused, answering}`.
Implements all floor events listed above, validates names, excludes self from
`room-state` (ghost-avatar fix), re-emits `pause-for-floor` to late joiners, and
on disconnect de-queues the user / clears speaker / resumes the lecture.

### 3.2 `lectureRoutes.mjs` — `/api`

- `GET /api/lectures` — catalog from `data/multimediaLectures.json`
  (8 Multimedia Computing lectures).
- `GET /api/lecture/segments/:lectureId` — **core endpoint**: if a
  pre-generated `summary.wav` exists → single segment; otherwise splits
  `summary.json` into ~140-word chunks → per segment CosyVoice `synthesize`
  (3 retries, markdown stripped via `cleanTextForTts`) → Rhubarb lipsync →
  cached under `lecture_cache/segments/<id>/`. Cycles animations
  (explain/explain2/explain3) and expressions.
- `POST /api/ask` — student Q&A: "Professor Abed" prompt + summary excerpt →
  Ollama (`qwen2.5:7b`, CPU, 220 tokens) → CosyVoice + Rhubarb → cached by MD5
  of `lectureId::question` under `lecture_cache/answers/`.
- `GET /api/lecture/pdf`, `/pdf_image` (pdftoppm → cached PNG of slide 1),
  `/summary`, `/summary_audio`, `/segment_audio`, `/answer_audio`,
  `/explain` + `/audio` (legacy intro path).

### 3.3 Modules

- `cosyVoiceClient.mjs` — `POST {COSYVOICE_BASE_URL}/synthesize` (multipart,
  voice `abed101` — a zero-shot clone), PCM16 → WAV via `audioUtils.mjs`.
- `ollamaClient.mjs` — `POST {OLLAMA_BASE_URL}/api/generate`.
- Legacy: `openAI.mjs` (LangChain + Zod structured output), `elevenLabs.mjs`,
  `lip-sync.mjs`, `defaultMessages.mjs` (pre-rendered intro WAVs in `audios/`).

### 3.4 `profbrain/` — offline lecture prep

- `prep_lectures.py` — `pdftotext` → clean → `lecture_notes.txt`, 300-word/50-
  overlap `chunks.json`, Ollama `qwen2.5:1.5b` → ~700-word `summary.json`.
- `prep_tts.py` — splits summary ≤180 words, synthesizes, concatenates →
  `summary.wav`.
- `query_rag.py` — standalone TF-IDF RAG CLI (not wired into the server).

### 3.5 CosyVoice / VoxCPM

- `CosyVoice/` — vendored CosyVoice2-0.5B FastAPI server with
  `/register_voice` (zero-shot cloning, persisted in `voice_registry.json`),
  `/synthesize`, `/transcribe` (Whisper), etc.
- `VoxCPM/` + `voxcpm-env/` — vendored VoxCPM2 TTS repo + local virtualenv;
  **not referenced by app code** — experimental alternative for voice cloning
  (Gradio UI, GPU LoRA fine-tuning WebUI).

---

## 4. Recent Changes (this session)

1. **Classroom menu redesign** — replaced the old right-side vertical panel in
   `Scene.jsx` with a top-center pill toolbar matching the reference screenshot:
   dropdowns for Raise Hand (3 options + floor status) and professor Avatar,
   pills for Camera/Chat/Settings, cyan Start Class button. All existing
   behavior preserved; only new prop is `cameraPreset` for the sublabel.
2. **AvatarPicker close button** — added an X button (`onClose`) so the
   change-avatar modal can be dismissed without selecting.

Verified with `vite build` — compiles cleanly.

---

## 5. Issues & Recommendations

### Bugs

- **`POST /sts` crashes** — calls `convertAudioToText` whose import is commented
  out (`server.js:~646` vs `:454`). Either restore the import or remove the route.
- **`ContinuousRecorder` double-plays audio** — it creates its own `Audio`
  element instead of tapping the shared `audioElementRef`, and auto-records on
  every message (potential echo/second playback).
- **`POST /settings` writes `.env` relative to CWD** — only correct if launched
  from `src/backend`.

### Security / design

- **`grant-floor` is unauthenticated** — any connected client can grant the
  floor to anyone. Consider a host/instructor role.
- Backend URLs are hardcoded to `http://localhost:3000` across the frontend —
  move to an env var (`import.meta.env.VITE_API_URL`).
- In-memory room state only — fine for a single-server demo; no persistence.

### Hygiene / dead code

- ~2,000+ lines of commented-out code across `server.js`, `useSpeech.jsx`,
  `SettingsPanel.jsx`, `ContinuousRecorder.jsx` — worth pruning.
- Unused files: `SpeechSystem.jsx` (CosyVoice Studio page, no route),
  `LecturePicker.jsx`, `AvatarFileSelector.jsx`, `RemoteUser.jsx`,
  `skeleton.js`.
- **Stale launch scripts**: `run_app.sh`, `cosyvoice_tts.sh`, and root
  `docker-compose.yml` still reference root `backend/`/`frontend/` directories
  — the code moved to `src/backend`/`src/frontend` in the repo restructure.
- `SOCIAL_INTERACTION_CURRENT_STATUS.md` is outdated — it claims the floor
  queue isn't implemented, but `server.js` now has the full system.
- `Scene.jsx` has an early `return <NotFound>` before hooks — works because
  config presence is stable per mount, but it violates rules-of-hooks ordering.
- VoxCPM + `voxcpm-env` are dead weight in the active path.

---

## 6. Repository Layout

```
NexoraXR/
├── src/
│   ├── frontend/          # React + R3F client (Vite, port 5173)
│   │   └── src/
│   │       ├── Scene.jsx          # classroom page + ClassroomPanel toolbar
│   │       ├── components/        # Scenario, Avatar, UserAvatar, RemoteAvatar,
│   │       │                      # ChatInterface, SpeakingTranscript, Joystick,
│   │       │                      # SettingsPanel, ContinuousRecorder
│   │       ├── hooks/useSpeech.jsx
│   │       ├── constants/         # visemes, morphs, expressions, lecture details
│   │       ├── landing/           # landing page sections
│   │       ├── scenes/configs/    # per-scene runtime JSON
│   │       └── services/lectureApi.js
│   ├── backend/           # Express + Socket.IO server (port 3000)
│   │   ├── server.js
│   │   ├── lectureRoutes.mjs
│   │   ├── modules/       # cosyVoiceClient, ollamaClient, legacy openAI/elevenLabs
│   │   ├── data/multimediaLectures.json
│   │   ├── lecture_cache/ # generated WAVs + lipsync (gitignored)
│   │   └── bin/rhubarb    # lipsync binary
│   └── assets/courses/    # lecture PDFs (gitignored)
├── profbrain/             # offline lecture prep (PDF→summary→TTS)
├── CosyVoice/             # vendored CosyVoice2-0.5B FastAPI server
├── VoxCPM/                # experimental alternative TTS (unused)
├── cosyvoice_tts.sh, run_app.sh, docker-compose.yml   # launchers (stale paths)
├── Nexora_report.md, SOCIAL_INTERACTION_CURRENT_STATUS.md,
│   TEACHING_PIPELINE_IMPLEMENTATION_REPORT.md         # older design docs
└── WORKSPACE_REVIEW.md    # this file
```
