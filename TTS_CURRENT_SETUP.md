# Current TTS Setup — VoxCPM2 / vLLM-Omni (as of 2026-11-07)

Report for the planned migration to `stream-tts` (`tts_component`). Investigation only — nothing was changed.

**TL;DR:** VoxCPM2 is served by **vLLM-Omni** (`vllm serve openbmb/VoxCPM2 --omni`) on **`:8010`** from the conda env **`voxcpm`**. The Node backend calls the OpenAI-compatible **`POST /v1/audio/speech`** endpoint, **non-streaming**, and receives a complete **48 kHz 16-bit mono WAV**. Voice cloning is done per-request via a `ref_audio` `file://` URI + `ref_text` looked up in `voxcpm_data/voice_registry.json`. Non-English output is verified with a persistent Whisper process, then cached as `.wav` files on disk and served to the browser as plain HTTP file downloads. Lip-sync is generated client-side in real time by spectral analysis — Rhubarb is no longer used.

---

## 1. TTS service itself

### 1.1 What runs today

| Item | Value |
|---|---|
| Server | `vllm serve openbmb/VoxCPM2 --omni` (vLLM-Omni, OpenAI-compatible API) |
| Host / port | `0.0.0.0:8010` |
| Started by | `voxcpm_tts.sh` (repo root) — also starts backend `:3000` and Vite `:5173` |
| Conda env | `voxcpm` (`~/anaconda3/envs/voxcpm`, Python **3.12.0**) |
| Key flags | `--gpu-memory-utilization ${VOXCPM_GPU_MEM_UTIL:-0.35}`, optional `--max-model-len $VOXCPM_MAX_MODEL_LEN`, `--allowed-local-media-path $(pwd)` (lets the server read `file://` reference clips from the repo) |
| Logs / PID | `logs/voxcpm.log`, PID in `.run_pids` |

`voxcpm_tts.sh` command (lines 38–41):
```bash
nohup vllm serve openbmb/VoxCPM2 --omni --host 0.0.0.0 --port 8010 \
  --gpu-memory-utilization "${VOXCPM_GPU_MEM_UTIL:-0.35}" \
  "${MAX_LEN_ARGS[@]}" \
  --allowed-local-media-path "$(pwd)" > logs/voxcpm.log 2>&1 &
```

### 1.2 Model & weights

- Model id: **`openbmb/VoxCPM2`** (env-overridable via `VOXCPM_MODEL`; default in both `voxcpmClient.mjs` and `env.template.txt`).
- Weights: HuggingFace cache, **not vendored in the repo** —
  `~/.cache/huggingface/hub/models--openbmb--VoxCPM2` (**4.7 GB**: `model.safetensors`, `audiovae.pth`, tokenizer files).
  `models--openbmb--VoxCPM1.5` also exists in the cache but is metadata-only (12 KB). `VoxCPM.from_pretrained()` (used only by the legacy server below) resolves to the HF cache; vLLM does the same.
- Native output: 48 kHz float32 → served as **48 kHz PCM16 mono WAV** (verified on cached files: `segment_000.wav` = 48000 Hz, 1 ch, sampwidth 2).

### 1.3 Python environment — `voxcpm` conda env (Python 3.12.0)

| Package | Version | Used for |
|---|---|---|
| `vllm` | 0.30.0 | TTS serving |
| `vllm-omni` | 0.30.0 | omni/audio endpoints (`/v1/audio/speech`) |
| `torch` | 2.13.0 | backend |
| `torchaudio` | 2.11.0 | backend |
| `voxcpm` | 2.0.3 | **only used by the legacy `voxcpm_server.py`** — the vLLM path doesn't need it |
| `openai-whisper` | 20250625 | language verification (`whisper_service.py`) |
| `flashinfer-python` | 0.6.18.post1 | vLLM attention backend |
| `flash-attn` | **not installed** | — |
| `nano-vllm-voxcpm` | **not installed here** | installed in the `tts` env instead (see §6) |
| fastapi/uvicorn/scipy/numpy | 0.136.3 / 0.53.0 / 1.18.1 / 2.3.5 | legacy server + misc |

Other conda envs present: `base`, `cosyvoice` (leftover from the pre-VoxCPM CosyVoice integration — torch 2.3.1), `cv`, `tts` (Python 3.11 — belongs to the new stream-tts repo, see §6).

### 1.4 GPU & env vars

- GPU: NVIDIA RTX 4000 Ada, 20 GiB. vLLM takes `gpu-memory-utilization` 0.35 (~7 GB); Ollama/Whisper share the rest. `ollamaClient.unloadModel()` evicts Ollama models before the audio-bake phase to free VRAM.
- TTS env vars:
  - `VOXCPM_BASE_URL` — default `http://localhost:8010` (`voxcpmClient.mjs`, `bake.mjs`, `package.json` dev script, `env.template.txt`, e2e tests, `voxcpm_tts.sh`).
  - `VOXCPM_VOICE_ID` — default `abed101`.
  - `VOXCPM_MODEL` — default `openbmb/VoxCPM2`.
  - `VOXCPM_VOICE_REGISTRY` — overrides path to `voxcpm_data/voice_registry.json` (used by tests).
  - `VOXCPM_REF_WAV`, `VOXCPM_REF_TEXT` — last-resort reference clip/text fallbacks.
  - `VOXCPM_GPU_MEM_UTIL`, `VOXCPM_MAX_MODEL_LEN` — read by `voxcpm_tts.sh`.
  - `VOXCPM_MODEL_ID` — read only by the dead `voxcpm_server.py`.
  - Whisper verification: `WHISPER_PYTHON` (default `~/anaconda3/envs/voxcpm/bin/python`), `WHISPER_MODEL` (`base`), `WHISPER_NO_SERVICE`, `WHISPER_DETECT_TIMEOUT_MS` (90 s), `WHISPER_DEVICE` (`cuda|cpu`, auto-picked: CUDA only if >7 GiB free).
  - Bake-related: `COURSE_TTS_CONCURRENCY` (2), `COURSE_DUR_RATIO_MIN/MAX` (0.5/3.0), `COURSE_BAKE_LANGS`, `COURSE_AUDIO_MIN_S/MAX_S` (240/1200), `PREP_LANGS`, `TRANSLATE_CONCURRENCY`, `NXR_UTTERANCE_TIMEOUT_MS` (45 s), `NXR_UTTERANCE_STUB`, `NXR_AGENT_DYNAMIC`.

### 1.5 Dead/legacy server file: `voxcpm_server.py` (repo root)

A **superseded** FastAPI wrapper around the `voxcpm` pip package (committed in `7c9c77f` "Migrate TTS pipeline from CosyVoice to VoxCPM2"). It exposed `GET /health`, `GET /voices`, `POST /register_voice`, `POST /synthesize` (streaming PCM16 @24 kHz) on ports **5001/5000**, mirroring the old CosyVoice contract. **Nothing in `src/` references it** — the active client talks to `:8010`'s OpenAI API. It is dead code; the only reason `voxcpm` (the pip package) is in the env.

---

## 2. API contract (backend → TTS service)

Exactly **one** endpoint is called — the OpenAI-compatible speech endpoint:

| | |
|---|---|
| Method / path | `POST {VOXCPM_BASE_URL}/v1/audio/speech` |
| Request JSON | `{ model, input, voice: "default", response_format: "wav", stream: false, ref_audio?, ref_text?, language?, instructions? }` |
| `ref_audio` | `file://<abs path to prompt.wav>` — resolved **server-side** by vLLM (`--allowed-local-media-path`) |
| `ref_text` | transcript of the reference clip (from the registry) |
| `language` | ISO code — **accepted but ignored** by the VoxCPM2 adapter; conditioning really comes from the per-language ref clip (see below) |
| `instructions` | `"Speak only in <Language>."` for non-English requests (accent-drift mitigation) |
| Response | **Complete WAV** (48 kHz, 16-bit, mono) in the body. `stream:false` — the whole clip is buffered; nothing is streamed anywhere in the pipeline |
| Errors | non-2xx → `VoxCPM error: <status> <text>`; 4xx treated as non-retryable |

**Voice cloning:** there is **no `/register_voice` HTTP call** in the current path. A "voice" is a directory `voxcpm_data/voices/<voice_id>/prompt.wav` plus an entry in `voxcpm_data/voice_registry.json` → `{ prompt_wav: <abs path>, prompt_text: <transcript> }`. Registered voices: `abed101` (English base, ~30 s) and per-language clones `abed101_{ar,zh,es,fr,de}`. `refForVoice(voiceId, lang)` prefers `<voiceId>_<lang>` (a reference clip in the target language is the strongest conditioning the adapter offers), falls back to base → `VOXCPM_VOICE_ID` → first registry entry → `VOXCPM_REF_WAV`. `opts.noRef` drops both fields (rescue path for wrong-accent openings). `voice_id` values are just registry keys — chosen manually/by convention, no UUID generation in the current flow (the dead `voxcpm_server.py` generated 8-char uuids).

**Post-synthesis verification** (`synthesizeVerified`): non-English WAVs are checked by Whisper (`whisper_service.py`, persistent stdin/stdout JSON-lines process in the `voxcpm` env, `base` model, 3-second windows → `[{lang, prob}]`). ≥0.7-confidence foreign windows get a `transcribe_window` second opinion; proper-noun tolerance; majority vote must clear half the windows. Up to 3 attempts; English skips detection. Failure throws → caller's sentence-split rescue splits on `[.!?。！？…؟]`, synthesizes each sentence, re-verifies, joins with `joinWavs` (`audioUtils.mjs`).

---

## 3. Backend integration (Node/Express, `src/nexora_server` + `src/nexora_ai`)

### 3.1 Call sites — every file that touches the TTS service

| File | Function(s) | What it synthesizes |
|---|---|---|
| `src/nexora_ai/modules/voxcpmClient.mjs` | `synthesize`, `synthesizeVerified`, `getDefaultVoice`, `listVoices` | **the only module that talks to :8010** (`VOXCPM_BASE_URL`) |
| `src/nexora_ai/routes/lectureRoutes.mjs` | `generateSegmentAudio` (exported), `POST /ask`, `POST /recap`, `generateLectureUtterance` → `POST /lecture/utterance`, `POST /lecture/explain`, `GET /lecture/summary` | segment narration, floor answers, catch-up recaps, dynamic utterances, legacy explain/summary audio |
| `src/nexora_server/courses/bake.mjs` | `bakeLecture`, `warmLectureUtterances`, `verifyCourseAudio`, `checkDurationRatios`, `ttsReachable` | pre-baked course audio; calls `generateSegmentAudio`/`generateLectureUtterance` |
| `src/nexora_server/courses/builds.mjs` | `runAudioPhase` → `verifyCourseAudio`; `runTranslationPhase` → `prepareTranslations` | course build pipeline stages |
| `src/nexora_server/courses/repair.mjs` | `repairLecture`/`repairCourse` | re-bakes missing/failed segments & utterances |
| `src/nexora_server/courses/drafts.mjs` | `invalidateSegmentAudio`, `prepareTranslations` | deletes stale `.wav/.txt/_lipsync.json`; writes translated `segment_NNN.txt` into the cache |
| `src/nexora_server/server.js` | mounts `lectureRouter` at `/api` (line 1372); `emitNextLectureUnit` → `generateLectureUtterance`; `ask-floor-question` → self-POST `/api/ask` or `/api/recap`; `POST /api/lecture/:lectureId/segment/:lang/:idx` (+`/retranslate`) → `generateSegmentAudio`; `POST /api/courses/:id/approve-audio`, `/prepare-audio` → `runAudioPhase` | runtime professor speech + admin repair |
| `src/nexora_server/protocol/languageReady.mjs` | `isLanguageReady`, `lectureReadiness` | readiness gate — checks cached `.wav`/`.txt` exist (no TTS calls) |
| `src/nexora_ai/scripts/prep_multilingual.mjs` | hits `GET /api/lecture/segments/:id?lang=` | warms manifests for Lecture_1..8 |
| `src/nexora_ai/modules/langDetect.mjs` + `whisper_service.py` | `detectLanguagesWindowed`, `detectLanguageWindowTranscribe`, `detectLanguageFromWav` | Whisper verification sidecar |

### 3.2 How text is sent

**Not streamed.** Ollama (`qwen3:8b` for utterances/answers — `OLLAMA_STRONG_TRANSLATE_MODEL`/`OLLAMA_TRANSLATE_MODEL`/`OLLAMA_MODEL` configurable; `generate()` uses `stream:false`, `think:false` for qwen3) produces the **complete** text first, then `cleanTextForTts()` strips markdown/brackets/bullets, and the whole string goes to `/v1/audio/speech`. Only on verification failure does it fall back to per-sentence synthesis + `joinWavs`. Segment text comes from `profbrain/lectures/<id>/segments.json` or `summary.json` split by `splitSummaryText` (~140 words).

### 3.3 Audio caching (filesystem)

| Cache | Location | Key |
|---|---|---|
| Segment narration | `src/nexora_ai/lecture_cache/segments/<lectureId>` (en) / `<lectureId>__<lang>`/ | `segment_NNN.wav`, `segment_NNN.txt`, `segment_NNN_lipsync.json` |
| Floor answers (`/ask`, `/recap`) | `src/nexora_ai/lecture_cache/answers/` | `<md5(lectureId::lang::seg::question)>.wav` (+ `_lipsync.json`) |
| Dynamic utterances | same dir | `utt_<md5(...)>.wav`, `.txt`, `_lipsync.json` |
| Explain cache | `src/nexora_ai/lecture_cache/` | `<lectureId>.wav` + `<lectureId>.json` |
| Lecture summary | `profbrain/lectures/<id>/` | `summary.wav`, `summary_audio.json`, legacy `lipsync.json` |
| Legacy default messages | `src/nexora_ai/audios/` | `intro_0/1.wav`, `api_0/1.wav` (+ Rhubarb JSON) |

The `_lipsync.json` files are now **marker/provenance artifacts** (`{"baked":true,"segment":N,"lang":...,"durationMs":...}`) — real lip-sync is computed client-side (§4). ~117 segment dirs, ~1900 answer/utterance files currently cached.

### 3.4 Pre-generated narration

Course build: `POST /api/courses/:id/build` → scripts → `approve-scripts` → `runTranslationPhase` (`prepareTranslations` writes `profbrain/.../translations/<lang>.json` + `segment_NNN.txt` cache) → `approve-audio`/`prepare-audio` → `runAudioPhase` → `unloadModel()` (frees Ollama VRAM) → `verifyCourseAudio` → `bakeLecture` per lang (concurrency 2, duration-ratio sanity check 0.5–3.0 vs English, failed segments deleted + flagged in Postgres `artifacts`) + `warmLectureUtterances` (opening/transitions/closing_recap). Readiness gate (`isLanguageReady`) requires **every** segment `.txt`+`.wav` **and** all planned utterances before a room may use a language. Runtime `GET /api/lecture/segment_audio/:id/:idx` lazily synthesizes **English only**; missing non-English clips 404 (no mid-lecture TTS storm).

### 3.5 Interruption (floor question mid-lecture)

Socket.IO NCIP protocol — TTS audio is just a paused `<audio>` element; no TTS-side cancellation exists:

1. Client `request-floor` → `ncip.requestFloor` → broadcast `lecture-control {action:'pause-for-floor'}` → each client `pauseLectureForFloor()` pauses the `<audio>`, stores `resumeAt`; the holder reports `lecture-checkpoint {segmentIndex, playbackOffsetMs, slidePage, slideDoc}` → stored as authoritative `interruption.checkpoint`.
2. `ask-floor-question` → server self-POSTs `/api/ask` (or `/api/recap` for catch-up) → `synthesizeVerified` → `answerReady` → `professor-speak {floorAnswer:true, audioUrl}` → clients `prependMessages` (plays immediately); `answer-ended` → `resume` action with the checkpoint → `resumeLecture()` seeks `audio.currentTime = offset`.
3. Timeouts: floor 30 s, THINKING 60 s, utterance 45 s (`NXR_UTTERANCE_TIMEOUT_MS`); stale-generation tokens drop late answers. Private rooms: host pause uses `pause-for-host`/`hostResume` (same checkpoint path, no floor grant).

---

## 4. Frontend (React/Three.js)

### 4.1 Audio transport & playback

- Transport is **plain HTTP file download**, not streaming: messages carry `audioUrl` (`/api/lecture/segment_audio/...`, `/answer_audio/<key>`, `/utterance_audio/<key>`) delivered via Socket.IO `professor-speak`; `Scene.jsx:1423` resolves relative paths against `API_URL` (Vite proxies `/api`+`/socket.io` to `:3000`; `VITE_API_URL` overrides).
- `Avatar.jsx` (queue head = `useSpeech().message`) creates `new Audio()`, `crossOrigin='anonymous'`, `src=audioUrl`, plays on `playing`; `onended/onerror → onMessagePlayed()` pops the queue; `resumeAt` applied after `loadedmetadata`; a 400 ms interval snaps `currentTime` to the shared server clock (`unitStartedAt` + `serverTimeNow`, ±0.35 s tolerance). Next-segment audio is prefetched while the head plays (`Scene.jsx:888`). Legacy path also accepts `message.audio` = base64 data-URI (old ElevenLabs/default messages).
- `ChatInterface.jsx` free-chat (`tts()`) posts to `POST /tts` — the **legacy OpenAI+ElevenLabs endpoint** (`server.js:169`, `lip-sync.mjs` → `elevenLabs.mjs`); effectively dead without API keys.

### 4.2 Lip-sync / visemes

- **Real-time, client-side, no Rhubarb.** `realtimeLipSync.js` taps the professor's `<audio>` with `createMediaElementSource → AnalyserNode` and classifies each frame (RMS + 3 spectral bands: 120–700 / 700–2500 / 2500–8000 Hz) into Oculus-style `viseme_*` targets (`SS/FF/TH/U/O/E/aa/sil`), lerped in `useFrame` together with a `mouthOpen` drive.
- Remote-user voices use the same classifier on their WebRTC `MediaStream` (`attachStreamAnalyser`, boosted ×3–4; `RemoteAvatar.jsx`).
- Fallback: `message.lipsync.mouthCues` (legacy Rhubarb JSON) still rendered if the analyser can't attach — current payloads carry `lipsync:null`/marker objects, so it never fires. Vendored Rhubarb binary is unused.
- `SpeakingTranscript.jsx` reveals the segment text progressively off the same audio clock.

---

## 5. Removal/replacement inventory (VoxCPM-only)

**Delete or replace:**
- `voxcpm_tts.sh` — launcher (replace with `tts_component` start script)
- `voxcpm_server.py` — dead legacy FastAPI server (ports 5000/5001)
- `voxcpm_data/` — registry + 6 `prompt.wav` files (keep the clips if reused as references for the new service; format changes — stream-tts uses `/encode_latents` base64 instead of `file://` refs)
- `src/nexora_ai/modules/voxcpmClient.mjs` + `voxcpmClient.test.mjs` — replace with a stream-tts client (new contract: `POST /generate` streaming s16le PCM @48 kHz; `POST /encode_latents` for voices; `GET /ready`)
- `src/nexora_ai/modules/langDetect.mjs` + `whisper_service.py` — Whisper verification (keep only if the new service still needs language verification; it hardcodes `~/anaconda3/envs/voxcpm/bin/python`)
- `src/nexora_ai/scripts/prep_multilingual.mjs` — references `:8010`
- `src/nexora_server/package.json` `dev` script — `VOXCPM_BASE_URL=...`
- `src/nexora_server/env.template.txt` — VoxCPM section (lines 54–59)
- e2e tests setting `VOXCPM_BASE_URL` (`e2e/fresh_course_build.test.mjs:37`, `agentProgression.test.mjs:35`, `langswitch_reliability.test.mjs:46`)
- Env vars: `VOXCPM_*` (all), `WHISPER_*` (if verification is dropped)
- conda env `voxcpm` + HF cache `models--openbmb--VoxCPM2` (4.7 GB) — after confirming nothing else uses them (Whisper verify also lives there)
- `logs/voxcpm.log`, `logs/cosyvoice*.log` (rotating artifacts)
- `bake.mjs` `ttsReachable()` + error text; `docs/` references (informational)

**Adjust (shared, not pure-TTS):** `audioUtils.mjs` (`pcm16ToWav`/`joinWavs`/`wavPcm` — still needed if stream-tts PCM must be wrapped/joined), `lectureRoutes.mjs` synthesize calls + retry/sentence-split logic, cache layout (`*.wav` — keep format or migrate), `languages.mjs` `voiceSuffix`/`durationRatio` comments, `package.json` test lists, `server.js` comment strings.

**Already-dead legacy (separate cleanup):** `POST /tts`, `GET /voices`, `/settings` ElevenLabs keys, `modules/elevenLabs.mjs`, `modules/lip-sync.mjs`, `modules/openAI.mjs`, `modules/whisper.mjs` (commented out), `utils/audios.mjs` (ffmpeg webm→mp3), `audios/` legacy files, `elevenlabs-node` + `langchain`/`@langchain/openai`/`openai`/`pdfkit`/`tesseract.js` deps, vendored **Rhubarb** (`nexora_ai/bin*`, `lib/`, `include/`, `extras/`, `tests/`, `res/`, `README.adoc`, `LICENSE.md`, `CHANGELOG.md`), `docker-compose.yml` (no TTS service in it anyway), `cosyvoice`/`cv` conda envs, `OPENAI_*`/`ELEVEN_LABS_*` env keys.

---

## 6. Migration notes — new `stream-tts` service (already running outside the repo)

The replacement repo is already cloned at `~/MuhammadSaad_Workspace/voxcpm` (remote: `muhammadsaadkhankor/stream-tts`, "VoxCPM2 streaming TTS server + Voice Studio") and **running on `:8000`** via conda env **`tts`** (Python 3.11.0: `nano-vllm-voxcpm` 2.0.5, `flash_attn` 2.8.3, `torch` 2.8.0+cu128, `torchaudio` 2.8.0, `fastapi` 0.162.2). Its API differs from the current contract:

| | Current (vLLM-Omni :8010) | New (stream-tts :8000) |
|---|---|---|
| Synthesis | `POST /v1/audio/speech` → complete WAV | `POST /generate` → **streaming s16le PCM @48 kHz** |
| Voice cloning | `ref_audio` `file://` + `ref_text` per request | `POST /encode_latents` once → reusable `prompt_latents_base64` (+ required `prompt_text`) |
| Health | implicit | `GET /ready` → `{ready, sample_rate}` |
| Params | `language`, `instructions` | `target_text`, `cfg_value`, `temperature`, `seed`, `max_generate_length`, `response_format:"pcm"` |

Impacts: callers expect whole-WAV buffers (`joinWavs`, `wavDurationMs`, `writeFile`, `sendFile`) — either buffer the PCM stream and wrap with `pcm16ToWav` (already in `audioUtils.mjs`, needs 48000 not 24000) or refactor to true streaming; voice registry moves from `voxcpm_data/` files to encoded latents (transcripts still required); `language`/`instructions` fields disappear → rely on `prompt_text` + text language, and the Whisper `synthesizeVerified` layer becomes even more important.
