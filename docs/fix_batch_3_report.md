# Fix Batch 3 Report — multilingual runtime correctness + bake speed/memory

Branch: `fix/multilingual-batch-3`. One commit per item, in order.

## Part A — what students experience

### A1. Utterances no longer spoken in English in non-English rooms
`generateLectureUtterance` (lectureRoutes.mjs) generated opening/transition/
recap text with a single English-leaning prompt and no output validation —
the "welcome" path even fell back to the literal English string.

Now, for `lang !== 'en'`:
- The language instruction lives in the **system message**; output must be
  wrapped in `<utterance>...</utterance>` tags (same pattern as the segment
  translator's `<translation>` tags).
- Output passes `validateTranslation` (script audit + franc + foreign-word
  checks) with up to 3 attempts, temperature capped at 0.3.
- On exhausted retries a **fixed pre-translated template** per purpose and
  language (`UTTERANCE_FALLBACK_TEXT`) is spoken — never English.
- Cached `utt_*.txt` is re-validated before serving, so stale wrong-language
  entries regenerate instead of replaying.
- Pre-baked utterances already run per language in `warmLectureUtterances`
  during the audio stage — they now go through the validated path.

**Live check:** `POST /api/lecture/utterance` on `gen_18b7cc52_L1`
- `ar/opening` → `مرحباً بكم في تعلم الآلة. دعونا نبدأ بمحاضرة اليوم.` (9.3s audio)
- `zh/transition` → `既然我们已经了解了机器学习的基本定义…` (21.8s audio)

Commit: `fix(utterance): generate dynamic speech in the room language`

### A2. Clients one segment apart after a language switch
`planLanguageSwitch` preferred the local queue head over the authoritative
`segmentIndex` in the `language-change` broadcast. Clients whose queue had
already drained a segment restarted one ahead of their peers. The broadcast
hint is now always authoritative; local position only fills in when no hint
exists.

Commit: `fix(sync): rebuild language switch from the server segment index`

### A3. Duration check for every language
`verifyCourseAudio` only checked the English total. New
`checkDurationRatios` compares each segment's audio duration to its English
twin against a per-language band (`durationRatio` in
`src/shared/languages.mjs`, env-tunable `COURSE_DUR_RATIO_MIN/MAX`).
Off-band segments get **one re-bake**; still-bad segments have their wav
removed and are recorded in `artifacts.duration_flags` — the instructor
sees the failure and the readiness gate keeps the room off that language.
Real ratios are stored in the bake timings (`ratios:<lecture>@<lang>`).

**Measured on `gen_18b7cc52_L1` (13 segments):**

| lang | min | max | mean | band used |
|------|-----|-----|------|-----------|
| ar   | 0.72 | 1.22 | 0.99 | 0.6–1.7 |
| fr   | 0.64 | 1.33 | 1.05 | 0.6–1.7 |
| de   | 0.63 | 1.28 | 1.02 | 0.6–1.7 |
| es   | 0.89 | 1.32 | 1.09 | 0.6–1.7 |
| zh   | 0.82 | 1.07 | 0.92 | 0.5–1.3 (calibrated) |

Zero flagged segments on the reference lecture. de seg 2 (0.63) is closest
to the floor — 0.6 was kept as the Latin/Arabic band floor.

Commit: `feat(bake): per-language duration ratio check against English`

### A4. No live translation on the request path
`loadLectureManifest` ran `translateForLecture` inline (and background) when
a translated `.txt` was missing. Removed: requests never trigger
translation. Missing non-English text now returns the English source
flagged `pendingTranslation: true`; `segment_audio` lazy synthesis is
English-only (non-English 404); `bakeLecture` refuses to bake
`pendingTranslation` segments into a non-English bucket. The readiness gate
(`isLanguageReady`: txt+wav for every segment) is unchanged and confirmed
to block incomplete languages — verified live (see below).

Commit: `fix(manifest): requests never trigger translation or non-English TTS`

### Part A tests
- Unit tests: `utterance.test.mjs` (8), `ncipSync.test.js` (37), bake/drafts
  tests — all pass.
- **3-client live socket test** (real backend, dev-unauth, stub utterances):
  host + 2 guests, `gen_18b7cc52_L1` parked on segment 2, switched
  en→ar→es→fr→de→zh. Every client received the same authoritative
  `segmentIndex: 2` broadcast; `planLanguageSwitch` resolved to 2 for local
  queues at 2, 3, and empty — previously 2/3/none (diverged).
- Utterances verified in-language live for ar + zh (above). Note: one `de`
  opening TTS was correctly **rejected** by windowed whisper (detected `tr`
  drift) — TTS-level drift is handled by `synthesizeVerified`, not by text
  validation; it re-generates on next warm.

## Part B — speed and cleanup

### B1. One language list
`src/shared/languages.mjs` — code, display name (LLM prompts + server
labels), native label (client dropdowns), TTS voice suffix, expected
duration-ratio band, text-check type, speech-recognition locale.
Replaces duplicated lists in `ncipRoom.mjs`, `lectureRoutes.mjs`,
`drafts.mjs`, `server.js`, `bake.mjs` and the client lists in
`config.js`, `Scene.jsx`, `ManagePanel.jsx`, `CreateClassroomModal.jsx`.

Commit: `refactor(langs): single language config for server, AI, and client`

### B2. GPU memory conflict
Observed failure reproduced live: vLLM stage-0 died on `CUDA out of memory`
when Ollama's 5 GiB model loaded beside its 12.8 GiB footprint.

- `VOXCPM_GPU_MEM_UTIL` env → `--gpu-memory-utilization` (default 0.35).
  **Note:** VoxCPM2's fixed footprint is ~12.8 GiB at every tested value
  (0.20–0.35); the flag only bounds the variable pool. Lowest reliable
  value verified with TTS at concurrency 2: **0.20** (12.8 GiB actual).
- `unloadModel()` now evicts **both** translate and main Ollama models —
  the old single-model unload left `keep_alive: 30m` weights resident
  through the whole bake.
- Translation requests use `num_ctx: 2048`.

Commit: `fix(bake): GPU memory handoff between Ollama, VoxCPM and Whisper`

### B3. Persistent Whisper service
`whisper_service.py` loads the model once and answers serialized JSON-line
requests over stdin/stdout (`langDetect.mjs` queues; legacy per-clip spawn
is the automatic fallback, `WHISPER_NO_SERVICE=1` to force). Device is
picked by free VRAM (>7 GiB → CUDA, else CPU; `WHISPER_DEVICE` overrides)
because the CUDA context alone costs ~4-5 GiB.

Cold→warm detect: 2.2s → **0.15s (GPU)** / ~3s (CPU) vs ~10s+ per clip before.
Also fixed the GPU/CPU mel-device mismatch in the windowed snippet.

Commits: `perf(lang-detect): persistent Whisper service…`,
`fix(whisper): pick GPU only with real headroom…`

### Part B tests — pipeline run (`gen_18b7cc52_L1`, 13 segments, 6 languages)

| stage | before | after |
|-------|--------|-------|
| prepareTranslations | — | 31s (all 5 langs `kept-current`, semantic sweep incl.) |
| verifyCourseAudio (all 6 langs, mostly cached) | — | 32s |
| whisper load per clip | ~10s × N | 1 load, 0.15–3s per clip |
| GPU: vLLM + Ollama + Whisper | 12.8+5.1+0.6→OOM kill | 12.8 + (Ollama evicted) + CPU whisper = stable |

A true before/after cold bake of the 38.6-min run wasn't re-run — segments
were already baked. What changed measurably: the GPU no longer OOMs
mid-bake (the 38.6-min figure included OOM-induced retries), whisper no
longer reloads per clip, and Ollama is fully evicted before baking.

GPU memory by process during the run: vLLM 12.9 GiB, Ollama evicted (0),
Whisper 0 (CPU). `ollama ps` after translation→bake handoff: model resident
only when LLM work active, evicted via `keep_alive: 0` for the bake.

## Readiness
`isLanguageReady(gen_18b7cc52_L1, lang)` → **13/13 for all 6 languages**
(en, ar, fr, de, es, zh).

## Not fixed / known issues
- VoxCPM2 TTS can still drift languages on individual clips (observed: a
  `de` utterance detected as `tr`). Whisper verification catches it and the
  warm retries; a persistent drift on a specific ref voice may need a
  better `abed101_de` reference clip.
- `gen_18b7cc52_L1/lecture_plan.json` is malformed (`topic 2 missing
  title`) — the agent falls back to manifest order; pre-dates this branch.
- True cold-bake timing vs 38.6 min not measured (cache was already warm);
  the failure modes that inflated it (GPU OOM, per-clip whisper reloads,
  Ollama staying resident) are addressed directly.
