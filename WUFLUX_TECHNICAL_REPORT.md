# WuFlux (NexoraXR) — Technical Report

*A multilingual, AI-driven virtual classroom: an LLM-orchestrated professor
avatar teaches PDF-derived lecture content to multiple students in a shared
3D room, with a cloned voice, baked neural lip-sync, and mid-lecture
question answering — in six languages.*

Date: 2026-11-08 · Repository: `NexoraXR` (evolved from the "Dtalk"
talking-avatar demo)

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Architecture](#2-architecture)
3. [Offline Content Pipeline (PDF → Classroom)](#3-offline-content-pipeline-pdf--classroom)
4. [Runtime: The Live Classroom](#4-runtime-the-live-classroom)
5. [Speech Synthesis (VoxCPM2 Streaming TTS)](#5-speech-synthesis-voxcpm2-streaming-tts)
6. [Lip-Sync: Two Implementations](#6-lip-sync-two-implementations)
7. [Frontend Rendering & Avatars](#7-frontend-rendering--avatars)
8. [Data, Caching & Persistence](#8-data-caching--persistence)
9. [Auth, Roles & Multiplayer](#9-auth-roles--multiplayer)
10. [Evaluation Methodology (Results Section Guide)](#10-evaluation-methodology-results-section-guide)
11. [Current Limitations & Known Debt](#11-current-limitations--known-debt)
12. [Appendix: File & Endpoint Map](#12-appendix-file--endpoint-map)

---

## 1. System Overview

WuFlux turns a static lecture PDF into a live, interactive, multilingual
virtual lecture. The pipeline has two halves:

- **Offline (build-time):** an instructor uploads course PDFs → the system
  extracts and chunks text → a local LLM (Ollama `qwen3:8b`) generates a
  spoken-style lecture script per lecture → the script is translated into
  five additional languages → every segment is pre-synthesized ("baked")
  into audio by a voice-cloned TTS engine (VoxCPM2) → lip-sync animation
  tracks are pre-baked by NVIDIA Audio2Face-3D.
- **Runtime (live):** students join a shared 3D classroom (React Three
  Fiber + Socket.IO). A deterministic **ProfessorAgent** state machine
  drives the lecture — playing baked narration segments in order,
  advancing slides in sync, generating dynamic utterances (openings,
  transitions, recaps), pausing when a student takes the floor, answering
  questions via RAG + LLM + TTS, and resuming exactly where it left off.

Supported languages: **English, Arabic, Chinese, Spanish, French, German**
(`src/shared/languages.mjs`). Mid-lecture language switching is supported
because slides, subtitles, audio, and lip-sync all share the same segment
index.

### Key properties

- **All-local inference** — no cloud APIs in the live path: Ollama (LLM),
  VoxCPM2/nano-vLLM (TTS), Whisper (language verification), Audio2Face-3D
  NIM (lip-sync bake). Legacy ElevenLabs/OpenAI code paths are dead.
- **Voice cloning** — a single professor voice ("abed101") cloned across
  all six languages via per-language reference clips.
- **Bake-then-play** — all deterministic lecture audio is precomputed;
  only dynamic events (questions, openings, transitions) hit live TTS.
- **Multiplayer state machine** — a custom protocol (NCIP) keeps
  professor status, floor control, playback position, and per-client
  catch-up consistent across joins, disconnects, and interruptions.

---

## 2. Architecture

### 2.1 Services and ports

| Port | Service | Stack | Role |
|---|---|---|---|
| 5173 | Frontend | React 18 + Vite 5, Three.js / react-three-fiber, Tailwind | 3D classroom, avatar rendering, chat UI |
| 3000 | Backend | Node.js ESM, Express 4, Socket.IO 4.8 | Orchestration, REST API, NCIP rooms, auth, build pipeline |
| 8000 | stream-tts engine | Python 3.11 (conda `tts`), FastAPI + nano-vllm | VoxCPM2 streaming TTS, voice-latent encoding |
| 3100 / 8080 | Voice Studio (optional) | FastAPI + React/TS | Voice-clone management tool (dev aid, not in lecture path) |
| 11434 | Ollama | — | `qwen3:8b` (scripts/translation/utterances), `qwen2.5:7b` (RAG/chat), `nomic-embed-text` (embeddings) |
| 5433 | PostgreSQL | embedded (`pg-embedded`) or external | users, courses, chunks/embeddings, builds, memory |
| 52000 | Audio2Face-3D NIM | Docker, gRPC | bake-time only: WAV → ARKit-52 blendshape tracks |

Single-GPU host: NVIDIA RTX 4000 Ada (20.5 GB VRAM). TTS is budgeted
(~0.35–0.8 GPU utilization depending on server flavor); Ollama models are
evicted (`unloadModel()`) before bulk audio baking to free VRAM.

### 2.2 Repository layout

```
NexoraXR/
├── src/
│   ├── nexora_client/      # React + R3F classroom client (:5173)
│   │   └── client_ui/      # separate React-19 landing-page app
│   ├── nexora_server/      # Express + Socket.IO backend (:3000)
│   │   ├── protocol/       # NCIP room state machine, room registry, language gate
│   │   ├── agent/          # ProfessorAgent policy, memory, lecture plan
│   │   ├── courses/        # ingestion, script generation, builds, baking, repair
│   │   ├── auth/           # passwordless (magic-link) auth, roles
│   │   ├── db/             # pg pool + migrations
│   │   └── e2e/            # node:test end-to-end suites
│   ├── nexora_ai/          # shared module mounted into the server at /api
│   │   ├── routes/         # lectureRoutes.mjs — core AI pipeline router
│   │   ├── modules/        # ttsClient, langDetect, ollamaClient, audioUtils…
│   │   └── lecture_cache/  # baked WAV/txt/lipsync/a2f + answers (gitignored)
│   ├── shared/languages.mjs
│   └── assets/             # GLB classroom, avatars, animations (not in git)
├── stream-tts/             # standalone VoxCPM2 TTS service (nested repo)
├── profbrain/              # offline Python content pipeline + lecture artifacts
├── eval/                   # baseline artifacts + generation run records
├── scripts/                # bake_a2f.py, link-assets.mjs, measure-translate.mjs
└── tts_voices/             # voice registry + per-language prompt.wav clips
```

### 2.3 Lifecycle scripts

- `start_all.sh` — kills ports → starts stream-tts engine (:8000) → waits
  for `GET /ready` (model load ~20–30 s) → backend (:3000) → frontend
  (:5173). Logs in `logs/`, PIDs in `.run_pids`.
- `stop_all.sh` — stops all three.
- `npm run dev` — backend + frontend only (assumes TTS, Ollama, Postgres up).
- `npm run db:local` / `db:setup` / `db:status` — embedded Postgres lifecycle.

---

## 3. Offline Content Pipeline (PDF → Classroom)

### 3.1 Stage 1 — Ingestion (`src/nexora_server/courses/pipeline.mjs`)

- Per-page text extraction with `pdf-parse`; OCR fallback via
  `tesseract.js` for image-only pages.
- Hierarchical document model: **Document → Sections → Chunks**
  (~700-word chunks).
- Chunks are embedded (`nomic-embed-text` via Ollama) and stored in
  Postgres `course_chunks` — these later power course-scoped RAG for
  student questions.
- A parallel Python toolset exists in `profbrain/` (`prep_lectures.py`)
  producing `lecture_notes.txt`, `summary.json`, `chunks.json` per
  lecture; eight curated Multimedia Computing lectures ship under
  `profbrain/lectures/Lecture_1..8/`.

### 3.2 Stage 2 — Script generation (`courses/generator*.mjs`)

- LLM (`qwen3:8b`) generates a spoken-style lecture script aligned to the
  source pages. The codebase carries a versioned lineage of generators
  (`generator.mjs` → `generator2/3/4.mjs`), each iteration tightening the
  prompt contract, validation, and structure.
- Output: structured lecture plan — segments (≈140-word narration units)
  with **document/page provenance**, teaching objectives, and topic
  blocks. `profbrain/build_plan.py` deterministically builds
  `lecture_plan.json` (topics `{id,title,segmentIds,slidePages}`) and
  **refuses** on misalignment.
- `profbrain/slide_mapper.py` — deterministic (no-LLM) hierarchical
  monotonic segment→PDF-page alignment → `slide_map.json`. This is the
  invariant that makes slide/audio/subtitle sync possible.
- Every generation run emits an eval record: `eval/records/records.csv`
  (`at,version,model,course,idx,title,words,estMin,llmCalls,revisions,
  elapsedMs,validation,segsWithDoc,segsWithPage,adminLeak`) plus detailed
  per-lecture JSON (token usage, timings, validation, plan blocks).
- **Draft/approve workflow** (`courses/drafts.mjs`): the instructor
  reviews generated scripts and explicitly approves before translation
  and audio are committed (`POST /api/courses/:id/approve-scripts`).

### 3.3 Stage 3 — Translation (`lectureRoutes.mjs :: translateForLecture`)

- Each segment is translated via Ollama chat with a strict
  `<source>`/`<translation>` tag contract, temperature ≤ 0.3.
- **Validation ladder:** up to 3 attempts per segment; rejects
  empty / identical-to-source / too-short / wrong-language output;
  `repairForeignSymbols` rewrites symbols/equations into speakable text
  for TTS; persistent failures escalate to a **strong-model rescue**
  (`qwen3:8b` strong translate override).
- Instrumentation is already in logs: `[translate] rejected`,
  `[translate] repaired`, `[translate] strong-model rescue`, and the
  cumulative counter `bakeStats.translationRetries`.
- Translated text lands in
  `profbrain/lectures/<id>/translations/<lang>.json` and per-segment
  `segment_NNN.txt` cache files — **every language bucket reuses the
  same segment indices**, which is what makes mid-lecture language
  switching coherent.

### 3.4 Stage 4 — Audio bake (`courses/bake.mjs :: bakeLecture`)

- `runAudioPhase` → `unloadModel()` (evicts Ollama to free VRAM) →
  `verifyCourseAudio` → `bakeLecture` per language (concurrency 2,
  `COURSE_TTS_CONCURRENCY`).
- Each segment → `synthesizeVerified` → VoxCPM2 `/generate` with the
  voice's per-language latents → WAV (48 kHz, 16-bit, mono) cached at
  `lecture_cache/segments/<lectureId>__<lang>/segment_NNN.wav`.
- **Sanity gates:** per-segment duration ratio vs English must be within
  0.5–3.0 (`COURSE_DUR_RATIO_MIN/MAX`); failed segments are deleted and
  flagged in Postgres `artifacts` for repair.
- `warmLectureUtterances` pre-bakes the standard dynamic utterances
  (opening, transitions, closing recap) so even "generated" speech is
  usually cache-warm.
- **Readiness gate** (`protocol/languageReady.mjs`): a room may use a
  language only when every segment `.txt`+.wav **and** all planned
  utterances exist — prevents mid-lecture TTS storms.
- **Repair path** (`courses/repair.mjs`): re-bakes only missing/failed
  segments; builds survive server restarts.

### 3.5 Stage 5 — Lip-sync bake (`scripts/bake_a2f.py`)

- Each baked WAV is sent to **NVIDIA Audio2Face-3D NIM** (gRPC
  `127.0.0.1:52000`, regression model `audio2face-3d-v2.3-Mark`, ~18.6M
  params) after 48 kHz → 16 kHz mono resampling.
- Output: `_a2f.bin` — `Float32` frames × 52 ARKit blendshape weights @
  **60 fps**, plus `_a2f.json` metadata (`frames`, `fps`, `durationSec`).
- ~12.5 KB/s per track → ~15 MB per lecture. Tracks are static files —
  **no runtime dependency on the NIM**.
- ARKit-52 names map 1:1 onto the Avaturn V2 avatar's morph targets.

---

## 4. Runtime: The Live Classroom

### 4.1 NCIP — Nexora Classroom Interaction Protocol
(`src/nexora_server/protocol/ncipRoom.mjs`)

A pure per-room state machine; every method returns an **effects list**
that `server.js` broadcasts via `io.to(roomId)`.

- **ProfessorStatus:** `IDLE · LECTURING · PAUSED · THINKING ·
  ANSWERING · RESUMING`.
- **Floor control:** student `request-floor` → grant → server emits
  `lecture-control {action:'pause-for-floor'}`; every client pauses its
  `<audio>` element; the floor holder reports
  `lecture-checkpoint {segmentIndex, playbackOffsetMs, slidePage,
  slideDoc}` which becomes the **authoritative interruption checkpoint**.
- **Progress tracking:** `lectureProgress` records topics taught,
  transitions taken, clarification counts, group-recap state, playback
  position, and per-participant catch-up anchors (late joiners get a
  recap rather than a replay).
- **Recovery:** `stateVersion` gap/stale classification → `session.sync`
  / `session.snapshot` → checkpoint resume. Client side lives in
  `classroom/services/ncipSync.js` + `ncipResume.js`.
- **Timeouts:** floor 30 s, THINKING 60 s, utterance 45 s
  (`NXR_UTTERANCE_TIMEOUT_MS`); stale-generation tokens drop late answers.

### 4.2 ProfessorAgent (`src/nexora_server/agent/`)

A **deterministic pedagogical policy** — no LLM in the decision loop:

| Situation | Action |
|---|---|
| Fresh lecture start | `speak_dynamic(opening)` |
| Topic boundary reached | `speak_dynamic(transition)` |
| Student flagged confusion | `speak_dynamic(reexplain)` |
| Late joiner(s) present | `speak_dynamic(group_recap)` |
| Lecture finished | `closing_recap` → `end_lecture` |
| Default | `speak_segment` (next baked unit) |

`validateAction()` is checked server-side before emitting. Supporting
memory: `professorMemory.mjs` (per-run: topics taught, questions,
clarification counts), `reexplainPolicy.mjs` (an LLM classifier decides
whether a question signals confusion worth re-explaining),
`userLearningMemory.mjs` (per-user cross-session memory persisted to
Postgres).

### 4.3 Normal lecture flow

1. `startLectureRun` → `professorDecide` → action.
2. `speak_segment`: manifest text + pre-baked segment WAV + `a2fUrl` +
   slide page → `io.to(roomId).emit('professor-speak', …)`.
3. Clients enqueue the message (`useSpeech`), download the audio over
   plain HTTP, fetch the A2F track, play; a 400 ms interval snaps
   `audio.currentTime` to the shared server clock (`unitStartedAt` +
   `serverTimeNow`, ±0.35 s tolerance — the `lectureClock` /
   `time.ping` mechanism). Next-segment audio is prefetched.
4. `lecture-segment-ended` drives the next `decide()`. Slides render
   client-side from `/api/lecture/pdf_image` PNGs per `slidePage`;
   `SpeakingTranscript` reveals text progressively off the same audio
   clock.

### 4.4 Student question flow (the interactive path)

1. Mic (browser Web Speech API) or text → `request-floor` → grant →
   professor pauses at checkpoint.
2. `ask-floor-question` (rate-limited 1/4 s, floor-holder validated) →
   status `THINKING`.
3. Server self-POSTs `/api/ask` `{question, lectureId, language,
   currentSegmentId}`:
   - position-aware context (current segment text) +
     **course-scoped RAG** — Postgres `course_chunks` embeddings,
     cosine ≥ 0.35, top-k 4 (`retrieveCourseContext`);
   - `buildAskPrompt` ("Professor Abed", answer only in room language);
   - Ollama → `synthesizeVerified` → VoxCPM2 with `abed101_<lang>`
     latents → WAV (+ Whisper language verification for non-English) →
     cached by `md5(lectureId::lang::seg::question)`.
4. `answerReady` → broadcast `professor-speak {floorAnswer:true}` →
   clients play immediately → `answer-ended` → resume from checkpoint
   (`audio.currentTime = offset`).
5. `maybeRecordClarification` writes the Q&A + confusion classification
   into professor/user memory for the next `decide()`.

`/api/recap` is the same machinery for late-joiner catch-up summaries
over a segment range.

### 4.5 Dynamic utterances

`generateLectureUtterance` (purposes: opening / transition / reexplain /
closing_recap / group_recap): grounded prompt over source segments →
`generateUtteranceText` (chat template, `<utterance>` tags, 3 attempts,
`validateTranslation`, `repairForeignSymbols`) → verified TTS →
`utt_<key>.wav` cache; per-language `UTTERANCE_FALLBACK_TEXT` safety net
if generation fails.

---

## 5. Speech Synthesis (VoxCPM2 Streaming TTS)

### 5.1 Engine (`stream-tts/server/voxcpm_server.py`, :8000)

- Model **`openbmb/VoxCPM2`** (4.7 GB HF cache) served via
  **nano-vllm-voxcpm** continuous batching.
- Env: `VOXCPM_GPU_UTIL=0.8`, `VOXCPM_TIMESTEPS=10`, `VOXCPM_MAX_SEQS=8`.
- API:
  - `GET /ready` → `{ready, sample_rate}`
  - `POST /encode_latents` `{wav_base64}` → reusable
    `prompt_latents_base64` (encode a reference clip once)
  - `POST /generate` — streams **raw s16le PCM mono 48 kHz**
    (`StreamingResponse`, `X-Audio-*` headers). Fields: `target_text`,
    `prompt_latents_base64` + `prompt_text` (same-language cloning),
    `ref_audio_latents_base64` (cross-lingual cloning), `cfg_value`,
    `temperature`, `seed`, `max_generate_length`.
- No internal sentence splitting — callers split (the backend already
  has `splitSummaryText` / sentence-split rescue).
- Measured: sub-second time-to-first-audio; ~3× realtime generation.

### 5.2 Backend client (`src/nexora_ai/modules/ttsClient.mjs`)

- Latent cache keyed by `sha256(prompt.wav)` under
  `tts_voices/.latents/` — reference clips are encoded once, reused
  forever.
- Voice registry `tts_voices/registry.json` + per-language
  `tts_voices/abed101_<lang>/prompt.wav` clips — a same-language
  reference clip is the strongest voice-consistency conditioning.
- Currently buffers the PCM stream into a WAV (`pcm16ToWav`) — the
  end-to-end streaming capability exists but the classroom path consumes
  complete files.

### 5.3 `synthesizeVerified` — the quality gate

For non-English output, each WAV is checked by a **persistent Whisper
service** (`modules/langDetect.mjs` + `whisper_service.py`, Whisper
`base`, 3-second windows → `[{lang, prob}]`):

- Windows with ≥ 0.7 foreign-language confidence get a `transcribe`
  second opinion (proper-noun tolerance).
- Majority vote must pass; up to 3 synthesis attempts.
- On failure: **sentence-split rescue** — split on `[.!?。！？…؟]`,
  synthesize each sentence, re-verify, `joinWavs`.
- This is the mechanism that guarantees **zero wrong-language audio
  reaches the client**.

---

## 6. Lip-Sync: Two Implementations

### 6.1 Baked Audio2Face-3D (`?lipsync=a2f`, preferred)

- Per-message `a2fUrl` → `_a2f.bin` Float32 ARKit-52 @ 60 fps.
- `Avatar.jsx` `useFrame`: `frame = track[floor(audio.currentTime *
  fps)]` → `lerpMorphTarget(name, weight)` — the existing name-based
  traversal fans each weight out to all six skinned meshes (Head, Teeth,
  Tongue, Eye, EyeAO, Eyelash).
- Indexed by `audio.currentTime` → pauses, seeks, and checkpoint resumes
  stay aligned automatically.
- Eye blinks stay on the random timer (A2F doesn't drive `eyeBlink*`).

### 6.2 Spectral fallback (`?lipsync=spectral`, always available)

`src/avatars/utils/realtimeLipSync.js` — Web Audio `AnalyserNode` taps
the playing `<audio>` element (fftSize 1024); per frame, RMS gating +
three spectral bands (120–700 / 700–2500 / 2500–8000 Hz) classify into
Oculus-style `viseme_*` targets (`SS/FF/TH/U/O/E/aa/sil`), lerped per
frame with a `mouthOpen` drive. The same classifier animates
remote-student avatars from their live mic `MediaStream`
(`attachStreamAnalyser`). This replaced the retired offline Rhubarb
phoneme pipeline.

### 6.3 Why two modes

A2F is a **bake-time asset** — ad-hoc speech (live answers that miss the
cache, remote student voices) has no track. The spectral path guarantees
the mouth always moves. This pairing also yields a clean **A/B
experiment** (same audio, `?lipsync=a2f|spectral`).

---

## 7. Frontend Rendering & Avatars

- **Avatar asset:** Avaturn V2 (`ProfAbed_suit.glb`) — chosen because V2
  has an animatable ARKit-52 face; Mixamo animation clips merged into
  `animations.glb`, mapped via `ANIMATION_MAP` (explain →
  TalkingOne/Two/Three, idle, happy…).
- **Facial control:** morph targets (`constants/morphTargets.js`,
  `facialExpressions.js`) + viseme/lip-sync layer + randomized eye
  blinks.
- **Scene:** `classroom/Scene.jsx` — GLB classroom, professor avatar,
  student avatars (`UserAvatar`, `RemoteAvatar`, `RemoteUser`), slide
  screen, subtitles.
- **Interaction:** `ChatInterface` (text + Web-Speech-API mic),
  `useSpeech` message queue (floor pauses, answer-ended reporting),
  `useVoiceChat`, `Joystick`, `LecturePicker`, `SpeakingTranscript`.
- **Presence:** `@react-three/xr` WebXR hooks exist (web-based XR, no
  Unity/native dependency).
- **Sync services:** `ncipSync.js` / `ncipResume.js` (stateVersion
  reconciliation, snapshot → checkpoint resume), `lectureClock.js`
  (server-time ping/pong).

---

## 8. Data, Caching & Persistence

### 8.1 Filesystem caches (`src/nexora_ai/lecture_cache/`)

| Content | Path | Key |
|---|---|---|
| Segment narration | `segments/<lectureId>` (en), `segments/<lectureId>__<lang>/` | `segment_NNN.{wav,txt}`, `segment_NNN_a2f.bin` |
| Floor answers | `answers/` | `<md5(lectureId::lang::seg::question)>.wav` |
| Dynamic utterances | `answers/` | `utt_<md5>.{wav,txt}` |
| Explain/summary | cache root, `profbrain/lectures/<id>/` | `<lectureId>.wav`, `summary.wav` |

`_lipsync.json` files are now provenance markers only; real sync comes
from `_a2f.bin` or the spectral analyser.

### 8.2 Lecture artifacts (`profbrain/lectures/<id>/`)

`lecture_notes.txt`, `summary.json`, `chunks.json`, `slide_map.json`,
`lecture_plan.json`, `segments.json`, `translations/<lang>.json`,
`slides/` PNGs.

### 8.3 PostgreSQL

users/sessions (argon2 magic-link auth), courses/drafts/builds,
`course_chunks` + embeddings (RAG), artifacts (bake status flags),
per-user learning memory. Embedded dev Postgres stores data in
`src/nexora_server/.pgdata`; migrations auto-apply on boot (`db:setup`
is idempotent — never drops data).

---

## 9. Auth, Roles & Multiplayer

- **Passwordless magic-link sign-in** (`src/nexora_server/auth/`):
  argon2, rate limiting, session middleware; dev mode prints links to
  the backend console (`AUTH_DELIVERY_MODE=console`), prod uses Resend.
- **Roles:** INSTRUCTOR / SUPER_ADMIN vs guests; guest sessions get
  classroom access without raise-hand/AI questions.
- **Rooms:** public and private (`protocol/roomRegistry.mjs`), invite
  links, host pause (`pause-for-host`, same checkpoint machinery),
  `room.kick`, `private-join-decision`.
- **Language gate:** room creation refuses languages whose audio bake is
  incomplete.

---

## 10. Evaluation Methodology (Results Section Guide)

The full plan lives in `EVALUATION_PLAN.md`; this section condenses it
into an executable recipe. Frame the results around the seven research
questions below — each maps to metrics, a measurement procedure, and a
fill-in table.

### 10.1 Research questions

- **RQ1 Lip-sync:** does baked A2F beat spectral, and does it hold in
  non-English (ar, zh)?
- **RQ2 Speech quality:** is the cloned voice intelligible and
  speaker-consistent across 6 languages?
- **RQ3 Translation:** does the pipeline produce validator-clean output
  with minimal retries?
- **RQ4 Sync correctness:** do slides/audio/lip-sync/cross-client
  playback stay aligned through a full lecture incl. pause/resume and
  language switch?
- **RQ5 Responsiveness:** are latencies classroom-tolerable?
- **RQ6 Robustness:** do reconnects, floor interrupts, language
  switches, and unbaked fallbacks degrade gracefully?
- **RQ7 Cost:** what does a full 6-language build cost (time, VRAM,
  storage)?

### 10.2 Metrics and how to measure them

**Lip-sync (RQ1)**

| Metric | Method | Target |
|---|---|---|
| MOS naturalness + sync accuracy | ≥5 raters, 1–5 scale, blind, randomized clips | A2F ≥ 4.0, ≥ +0.5 over spectral |
| ABX preference | same clip both modes, forced choice | A2F ≥ 70% |
| Automatic alignment offset | `xcorr(jawOpen_energy[t], rms(audio)[t])` per baked track — peak lag in ms | < 80 ms |
| Coverage | fraction of speech frames with non-silence jaw activity | A2F > spectral |

Design: 4 clips × 2 languages (en, ar) × 2 modes = 16 clips.
A/B switch: `?lipsync=a2f` vs `?lipsync=spectral`.

**TTS (RQ2)**

| Metric | Method | Target |
|---|---|---|
| WER (intelligibility) | Whisper-transcribe each baked WAV (`whisper_service.py` exists), WER vs source text | en < 10%, others < 15% |
| MOS naturalness | raters | ≥ 4.0 en / ≥ 3.5 others |
| Speaker similarity | reference clip vs generated, "same speaker?" 1–5 (or embedding cosine) | ≥ 4.0 en / ≥ 3.5 others |
| Speed / latency | generation × realtime; `/generate` E2E per ~45 s segment | ≥ 3× rt; ≤ 15 s |

**Translation (RQ3)** — from `logs/backend.log` + `bakeStats`:

`[translate] rejected` / calls (<10%), `repaired` %, `strong-model
rescue` count, validator-clean rate (should be 100% — enforced), mean
attempts/segment (≤1.2), wrong-language incidents (0).
`scripts/measure-translate.mjs` times the translation phase directly.

**Sync correctness (RQ4)**

- Slide↔segment alignment: shown page == `segments.json` page, 10/10.
- Cross-client drift: `[LECTURE_SYNC] corrected Xs` log entries —
  < 2 corrections/min, |diff| < 0.35 s.
- Audio↔text match: `[AUDIO START]` log vs segment text, 10/10.
- Pause/resume: resumeAt honored within ±0.5 s.
- Language switch mid-segment: next unit in new language with correct
  audio+track, ≤ 1 segment latency.
- A2F presence: every unit carries a fetchable `a2fUrl` (60/60 segments
  + 12/12 utterances for `my_L1`).

**Latency (RQ5)** — report p50/p95:

baked segment start < 1 s; dynamic utterance < 10 s warm; student
answer E2E < 15 s warm / < 30 s cold (model evicted); a2f fetch
< 200 ms.

**Robustness (RQ6)** — pass/fail scenario matrix R1–R8:

backend kill/restart mid-lecture (snapshot resume) · 15 s client
disconnect (grace-window resume) · floor interrupt mid-segment ·
mid-lecture language switch · unbaked ad-hoc answer (spectral
fallback, no frozen mouth) · forced `?lipsync=spectral` · NIM down
(static files → nothing breaks) · network jitter (drift corrector).

**Cost (RQ7)** — already measured for `my_L1`:

TTS bake 6 langs (~40 min audio) ≈ 13 min @ ~3× rt · A2F bake 72 files
≈ 15 min @ ~2.6× rt · peak VRAM ≈ 19 GB · live-class resident ≈ 8 GB ·
A2F storage ≈ 15 MB/lecture · NIM image 35.9 GB one-time.

### 10.3 Free instrumentation (already in place)

| Source | Yields |
|---|---|
| `logs/backend.log`: `[AUDIO START]`, `[LECTURE_SYNC] corrected`, `[translate] …` | slide/audio match, drift events, translation stats |
| `eval/records/records.csv` + `gen_*.json` | script-generation cost, tokens, validation outcomes |
| `/api/lecture/segment_a2f*` meta (`frames/fps/durationSec`) | track integrity |
| `nvidia-smi --query-compute-apps=pid,used_memory` | per-phase VRAM |
| `scripts/bake_a2f.py` summary | bake throughput |
| `whisper_service.py` | WER transcription + language verification |
| `stream-tts/tests/test_clone.py` | TTFA/RTF per cloning mode/language |
| Frontend console `[a2f] track load failed` | client-side failures |
| `src/nexora_server/e2e/` (`agentProgression`, `langswitch_reliability`, `privateSocial`, `fresh_course_build`…) | automated regression evidence |

### 10.4 Procedure checklist

1. `bash start_all.sh` (NIM only if re-baking).
2. Watch a full English lecture; log R3–R6 behaviors live.
3. Repeat segments 0–3 in ar + zh (exercises language switch).
4. Extract §10.2 numbers from logs.
5. Whisper-WER pass over ~10 random WAVs across languages.
6. MOS/ABX rater session (§4 of EVALUATION_PLAN).
7. VRAM snapshots per build phase.

### 10.5 Definition of success

A2F beats spectral on MOS + preference and holds in ar/zh · WER
acceptable in all 6 languages · zero wrong-language audio shipped ·
slide/audio/lipsync aligned 100% over a full lecture · cross-client
drift within ±0.35 s · all R1–R8 pass or degrade gracefully · full
6-language build reproducible < 60 min at ~19 GB peak VRAM.

---

## 11. Current Limitations & Known Debt

- **Legacy dead code** remains in-tree: ElevenLabs/OpenAI paths
  (`elevenLabs.mjs`, `openAI.mjs`, `whisper.mjs` commented out), vendored
  Rhubarb binary, `voxcpm_server.py` (old port 5000/5001), `docker-
  compose.yml` without a TTS service, `POST /tts` free-chat endpoint.
- **TTS streaming underused:** the engine streams PCM but the Node
  client buffers whole responses; true end-to-end streaming (lower
  perceived latency) is future work.
- **Two TTS eras coexist:** the doc-set describes both the older
  vLLM-Omni `:8010` path (`/v1/audio/speech`, `ref_audio` file://) and
  the current stream-tts `:8000` path (`/generate`, latents). The
  running system uses `:8000` per `start_all.sh`.
- **STT is browser-dependent** (Web Speech API) — no server-side ASR for
  student speech; Whisper is used only for output verification/eval.
- **A2F regression model is English-trained** — multilingual lip-sync
  quality (ar/zh) is precisely what RQ1 measures.
- **`stream-tts/` is a nested git repo** — should become a submodule or
  be gitignored (see `STREAM_TTS_REVIEW.md` §5).
- **ProfessorAgent decisions are deterministic** — pedagogy comes from
  memory + rules, not learned policy; an interesting future comparison.
- **`eval/` contains data, not a harness** — metrics are extracted from
  logs/records rather than run by a single evaluation script
  (consolidating one would strengthen reproducibility).

---

## 12. Appendix: File & Endpoint Map

### Key files

| Area | Path |
|---|---|
| NCIP state machine | `src/nexora_server/protocol/ncipRoom.mjs` |
| Room registry / language gate | `protocol/roomRegistry.mjs`, `protocol/languageReady.mjs` |
| Professor policy | `src/nexora_server/agent/professorAgent.mjs`, `lecturePlan.mjs`, `professorMemory.mjs`, `reexplainPolicy.mjs`, `userLearningMemory.mjs` |
| Course pipeline | `src/nexora_server/courses/{pipeline,generator*,builds,drafts,bake,repair,slides,llm}.mjs` |
| AI router | `src/nexora_ai/routes/lectureRoutes.mjs` |
| TTS client / verification | `src/nexora_ai/modules/ttsClient.mjs`, `langDetect.mjs`, `whisper_service.py` |
| Ollama client | `src/nexora_ai/modules/ollamaClient.mjs` |
| Avatar / lip-sync | `src/nexora_client/src/avatars/Avatar.jsx`, `utils/realtimeLipSync.js` |
| Client sync | `src/nexora_client/src/classroom/services/{ncipSync,ncipResume}.js`, `lectureClock.js` |
| TTS engine | `stream-tts/server/voxcpm_server.py` |
| Offline content tools | `profbrain/{prep_lectures,slide_mapper,build_plan,prep_tts,query_rag}.py` |
| Bakes / probes | `scripts/bake_a2f.py`, `scripts/measure-translate.mjs` |

### HTTP endpoints (backend :3000, all under `/api`)

`/auth/*` · `/api/rooms*` (create, private, invite, materials, public,
mine) · `/api/courses*` (CRUD, build, drafts, approve-scripts,
approve-audio, prepare-audio, lang-status, repair) · `/api/lectures` ·
`/api/lecture/{explain,audio,summary,summary_audio,pdf,pdf_image,
segments,segment_audio,segment_a2f*,answer_audio,utterance_audio}` ·
`POST /api/ask` · `POST /api/recap` · `/api/learning/user_memory/*` ·
`/api/admin/*` · `/settings` · legacy `POST /tts`, `GET /voices`.

TTS engine (:8000): `GET /ready`, `POST /encode_latents`,
`POST /generate`.

### Socket.IO events (NCIP)

Client → server: `join`, `leave`, `private-join-decision`, `time.ping`,
`session.sync`, `language.change`, `request-floor`,
`cancel-floor-request`, `release-floor`, `lecture-checkpoint`,
`ask-floor-question`, `answer-ended`, `lecture-segment-ended`,
`lecture-control`.

Server → client: `state-update`, `session.snapshot`, `professor-speak`,
`floor-state`, `mic-state`, `lecture-started`, `lecture-complete`,
`lecture-control`, `user-joined`, `user-left`, `guest-session`,
`room.kick`, `time.pong`.

### Environment variables (essentials)

`DATABASE_URL` · `OLLAMA_BASE_URL`, `OLLAMA_MODEL` (`qwen2.5:7b`),
`COURSE_LLM_MODEL` (`qwen3:8b`), `OLLAMA_TRANSLATE_MODEL`,
`OLLAMA_STRONG_TRANSLATE_MODEL` · `VOXCPM_BASE_URL`, `VOXCPM_VOICE_ID`
(`abed101`), `VOXCPM_MODEL` (`openbmb/VoxCPM2`), `VOXCPM_GPU_UTIL` ·
`WHISPER_PYTHON`, `WHISPER_MODEL` (`base`), `WHISPER_DEVICE` ·
`AUTH_DELIVERY_MODE`, `PUBLIC_BASE_URL`, `RESEND_API_KEY` ·
`COURSE_TTS_CONCURRENCY`, `COURSE_DUR_RATIO_MIN/MAX`,
`NXR_UTTERANCE_TIMEOUT_MS`, `NXR_AGENT_DYNAMIC`.

---

## Companion documents in this repo

| File | Covers |
|---|---|
| `EVALUATION_PLAN.md` | Full RQ/metric/target detail + results tables |
| `WuFlux_installationGuide.md` | Setup, env vars, services, troubleshooting |
| `TTS_CURRENT_SETUP.md` | TTS migration history (vLLM-Omni → stream-tts) |
| `STREAM_TTS_REVIEW.md` | stream-tts engine deep-dive |
| `LIPSYNC_A2F_REVIEW.md` | Audio2Face-3D feasibility/design |
| `NCIP_IMPLEMENTATION_REPORT.md`, `NCIP_SLICE2_REPORT.md` | protocol design history |
| `CLASSROOM_CREATION_PIPELINE.md`, `TEACHING_PIPELINE_IMPLEMENTATION_REPORT.md` | pipeline design |
| `docs/` | ~13 bug/fix incident reports (engineering log) |
