# NexoraXR — Multilingual Pipeline Report (en, ar, fr, de, es, zh)

How the codebase **actually** handles multiple languages today, across course
scripts, baked audio, and live mid-lecture language switching. Every claim
references real code. Unclear or unimplemented behavior is marked as such.

**Supported language list (single source of truth, duplicated in two places):**

- `src/nexora_server/protocol/ncipRoom.mjs:20` — `SUPPORTED_LANGUAGES = ['en','ar','fr','de','es','zh']`
- `src/nexora_ai/routes/lectureRoutes.mjs:166` — `LECTURE_LANGUAGES` map
- `src/nexora_server/courses/drafts.mjs:22` — `TRANSLATION_LANGS = ['ar','fr','de','es','zh']` (English is the canonical master, never a "translation")

Hindi is deliberately excluded in all three places — VoxCPM2 produced garbled
Hindi in testing (`lectureRoutes.mjs:173`, `ncipRoom.mjs:22`).

---

# Part 1 — Script translation pipeline

## 1.1 Where and when translation happens

Two distinct moments:

**A. Build time (the main path)** — `src/nexora_server/courses/builds.mjs:runAudioPhase()`
calls `prepareTranslations()` (`src/nexora_server/courses/drafts.mjs:373`) at the
start of the audio phase, i.e. **after** the instructor approves the English
scripts (`POST /api/courses/:id/approve-audio`, `server.js:644`). So translation
is *gated by human approval of English* — the machine translations are produced
from the reviewed canonical text, never from unreviewed drafts.

Flow inside `prepareTranslations` (drafts.mjs:373–426):

1. Query `course_lectures` for the course's lectures that have a script
   (`artifacts->'script' = '1'`).
2. For each lecture read `profbrain/lectures/<lectureId>/segments.json`
   (the canonical English draft, `version` field).
3. For each language in `TRANSLATION_LANGS`:
   - If a saved translation exists with `edited: true` → `kept-reviewed`
     (reviewer text is never overwritten).
   - If it exists, `basedOnVersion === current version` and segment counts
     match → `kept-current` (idempotent retry).
   - Otherwise translate **segment by segment** via `translateForLecture()`,
     write `translations/<lang>.json`, then mirror each segment's text into the
     runtime cache `lecture_cache/segments/<lectureId>__<lang>/segment_NNN.txt`
     so TTS bakes exactly this text.
4. One failed segment aborts that language (`status:'failed'`); other
   languages continue.

**B. Lazy/on-demand (fallback)** — `loadLectureManifest()`
(`lectureRoutes.mjs:291`) also calls `translateForLecture()` per segment
whenever a translated `segment_NNN.txt` is missing from the language cache
dir (lines 352–357). This means a manifest request for an un-baked language
triggers N sequential Ollama translations — slow, and it is exactly why the
server-side `language.change` handler has a "prepared" gate (see Part 3).

## 1.2 Translation model/provider and exact prompt

**Provider: local Ollama only.** `translateForLecture`
(`lectureRoutes.mjs:183`) calls `generateOllama` from
`src/nexora_ai/modules/ollamaClient.mjs:4`, which POSTs to
`OLLAMA_BASE_URL/api/generate` with model `OLLAMA_MODEL` — **default
`qwen2.5:7b`**, `num_predict: 800`, `num_gpu: 0` (CPU). OpenAI is *not* used
for translation even when `OPENAI_API_KEY` is set (OpenAI is only wired into
the course-*ingestion* LLM in `courses/llm.mjs`).

Exact prompt (lectureRoutes.mjs:185):

```
Translate the following lecture narration into ${LECTURE_LANGUAGES[lang]}.
Keep the same warm, spoken-lecture style and roughly the same length.
Output ONLY the translated narration — no notes, no headings, no commentary.

<text>
```

If Ollama returns an empty string, the function **silently falls back to the
English text** (`return translated || text`) — no error, no marker.

## 1.3 Per-segment or whole-lecture?

**Per segment.** `prepareTranslations` loops over `parsed.segments` and calls
`translateForLecture(s.text, lang)` one at a time, storing
`{id: s.id, text: translated}` (drafts.mjs:400–409). Each call is a separate
Ollama request — sequential, not parallelized.

## 1.4 Same segment count / order / slide pages — the guarantee

The mechanism is structural, not verified by the LLM:

- Translated segments are stored as `{id, text}` pairs where `id` **is the
  canonical English segment id** (drafts.mjs:403). Order is preserved
  trivially because translation iterates `parsed.segments` in order.
- Slide mapping is **language-independent**: `slide_map.json` and each
  segment's `page`/`document` live only on the canonical side.
  `loadLectureManifest(lectureId, lang)` builds the manifest from the
  *English* `segments.json`/`summary.json` segmentation and overlays the
  translated *text* at the same index — `slidePage`/`slideDoc` come from the
  English segment (`lectureRoutes.mjs:375–378`).
- **Count mismatch handling:** `prepareTranslations` only reuses a saved
  translation when `(existing.segments||[]).length === parsed.segments.length`
  (drafts.mjs:393) — otherwise it regenerates the whole language. So a stale
  translation with a different count is never kept.
- **What if the LLM merges/splits content?** Because translation is
  per-segment and the output is stored under the English `id`, a translated
  segment can be *empty-ish or wrong* but it can never shift the segment
  indexing — the count is guaranteed by construction, not checked after the
  fact. There is **no validation that the translated text is actually in the
  target language or non-degenerate** at the script level (that check happens
  on the *audio* instead — see Part 2).

## 1.5 "Uncertain alignment"

Applies to **reviewer-edited** scripts, in two functions:

- `alignSegments()` (drafts.mjs:89) — when a reviewer pastes a whole revised
  English script, each new segment is aligned to source `course_chunks` by
  word-set containment. If the best chunk covers < 0.5 (but ≥ 0.35) of the new
  vocabulary, or nothing matches at all (segment inherits its predecessor's
  document/page), the segment is stamped `mapped: 'uncertain'` (lines
  115–124). Comment: "never pretend it's certain."
- `alignLangSegments()` (drafts.mjs:433) — same idea for a reviewer-edited
  translation: a pasted translation segment that can't be matched to a
  canonical segment at containment ≥ 0.5 inherits a positional id and is
  flagged `uncertain`.

**Effect:** uncertain segments are **non-blocking warnings**, not errors.
`audioApprovalGate` (drafts.mjs:511–530) emits
`"<lec>/<lang>: N segment(s) on fallback slide"` warnings; the client surfaces
them via `approveBlocked`/`confirmUncertain` in the approval request
(`server.js:644+`, modal `approveAudio`). At runtime an uncertain segment
falls back to a safe slide.

## 1.6 Where translated scripts live; instructor visibility

- **Files:** `profbrain/lectures/<lectureId>/translations/<lang>.json` —
  `{lang, lectureId, version, basedOnVersion, fingerprint, edited,
  uncertainIndexes?, segments:[{id,text}]}` (`transPath`, drafts.mjs:352).
- **Runtime cache:** `src/nexora_ai/lecture_cache/segments/<lectureId>__<lang>/segment_NNN.txt` —
  mirrors of the translation, what `segment_audio` actually synthesizes from.
- **DB:** *no dedicated table* — language state is tracked inside
  `course_lectures.artifacts` JSONB (`baked_langs`, `partial_langs`) and
  `course_builds.stats` (`approved` fingerprints, `audio_langs`).

**Instructor UI:** `GET /api/courses/:id/drafts` returns per-language
reviewable drafts (the modal code comments and `server.js:461+` describe
"per-language reviewable translations"), and `saveLectureLangDraft`
(drafts.mjs:455) exists for saving edited translations. Whether the current
`CreateClassroomModal` review screen actually exposes per-language editing
tabs is **unclear from the code read** — the modal's `drafts` state maps
`d.segments` joined into one `fullText`, and `PUT /drafts` sends
`{lectureId, fullText}` (English path). `PUT /api/courses/:id/drafts` does
support language drafts server-side (it calls `saveLectureLangDraft`); the
client-side UI for it could not be confirmed and may be partial/absent.

## 1.7 Fingerprints per (lecture, language)

`scriptFingerprint(segments)` (drafts.mjs:170) = sha256 over `id:text` lines,
truncated to 16 hex chars.

- `textFingerprintForBake(lectureId, lang)` (drafts.mjs:488) fingerprints the
  canonical `segments.json` for `en`, or `translations/<lang>.json` otherwise.
- At `POST /approve-audio`, the server fingerprints every (lecture × selected
  language) pair and stores them in `course_builds.stats.approved`
  (`server.js:~700`). This binds baked audio to the exact approved text.
- **English edit invalidation:** `saveLectureDraft`/`saveLectureFullDraft`
  bump `segments.json` `version` and `invalidateSegmentAudio()`
  (drafts.mjs:322) deletes `segment_NNN.wav`/`_lipsync.json`/`.txt` for the
  changed indexes in **every** language bucket (`<lid>` and all `<lid>__*`).
  Translations then show as `outdated` in the gate because their
  `basedOnVersion` no longer matches the bumped canonical version → blocked
  from approval until re-prepared (drafts.mjs:522). Reviewer-edited
  translations (`edited:true`) are *not* auto-regenerated — they hard-block
  and need re-review.

## 1.8 Technical terms

**No special handling.** The translation prompt (`lectureRoutes.mjs:185`)
says nothing about preserving technical terminology — "regression",
"supervised learning", etc. are whatever `qwen2.5:7b` decides. So terms may be
translated, left in English, or handled inconsistently across segments and
languages. There is no glossary/do-not-translate mechanism anywhere in the
pipeline.

## 1.9 Translation time per lecture per language

**No measured numbers exist in the codebase** (no timing instrumentation on
`prepareTranslations`; only `stage_timings.translating_ms` is recorded on the
build row, builds.mjs:206). Estimate: ~10–20 segments/lecture × 1 Ollama
`qwen2.5:7b` call each on CPU (`num_gpu:0`, up to 800 tokens) — realistically
**tens of seconds to a few minutes per language, sequential across 5
languages**, so several minutes per lecture total. Actual numbers depend on
the host CPU; measure via `course_builds.stats.stage_timings`.

---

# Part 2 — Audio per language

## 2.1 TTS engine and voice per language

**One engine for all six: VoxCPM2**, served by `voxcpm_server.py` (or a
vLLM-Omni `openbmb/VoxCPM2` instance) behind `VOXCPM_BASE_URL` (default
`http://localhost:8010`), called through the OpenAI-compatible
`POST /v1/audio/speech` endpoint (`src/nexora_ai/modules/voxcpmClient.mjs:62`).

**Voice: the same professor voice for every language.** `getDefaultVoice()`
returns `VOXCPM_VOICE_ID` (default `abed101`) or the first registered voice.
Language is conditioned two ways (`voxcpmClient.mjs:31–43`):

1. `refForVoice()` prefers a per-language reference clip
   `<voiceId>_<lang>` (e.g. `abed101_ar`) from `voxcpm_data/voice_registry.json`
   when registered, falling back to the base voice — because VoxCPM2's adapter
   **ignores the request-level `language` field** (comment lines 28–30, 58–61).
2. `body.language = lang` is still sent — "harmless and forward-compatible".

So output language is *implicit/stochastic* — driven by input text +
reference audio, not by a parameter. Whether ar/fr/de/es/zh come out "good"
is empirical: the system treats VoxCPM2 output as unreliable enough to need
verification (below), and Hindi was removed entirely for quality reasons.

**Language verification:** `synthesizeVerified()` (voxcpmClient.mjs:94) —
non-English synthesis is Whisper-checked via `langDetect.mjs`
(`detectLanguagesWindowed`, 3-second windows, `whisper` in the `voxcpm` conda
env, model `WHISPER_MODEL=base`). A clip passes when ≥60% of windows detect
the expected language; otherwise it retries (up to 3 attempts in
`generateSegmentAudio`, bounded). English skips detection "empirically
stable" (line 96). There is **no ElevenLabs or other fallback per language** —
a failed verification throws and the segment bake fails.

## 2.2 Bake time per lecture per language

Not instrumented per-call in a queryable way; `verifyCourseAudio`
(`courses/bake.mjs:155`) does record `timings[<lectureId>@<lang>]` into the
report but doesn't persist them visibly. Estimates: bake runs at
`CONCURRENCY=2` segments in flight; each non-English segment costs TTS
generation **plus** a Whisper windowed transcription pass (one Python model
load per clip — the heaviest part). Expect **minutes per lecture per
language**; the modal itself warns a full 6-language bake "regularly exceeds
20 min" (CreateClassroomModal.jsx:74 comment). On retry, cached
`segment_NNN.wav` files are skipped (`generateSegmentAudio` early-returns at
lectureRoutes.mjs:216).

## 2.3 Duration differences and the 4–20 min check

`AUDIO_MIN_S=240` / `AUDIO_MAX_S=1200` (bake.mjs:27–29). **Only English is
duration-checked** (bake.mjs:177: `if (lang === 'en')` → `audioOnTarget`).
German/Arabic running long cannot fail the build — the check doesn't apply to
them. Whether a translated lecture is shorter/longer than English is simply
untracked. Slide timing is per-segment (one slide per segment), so duration
differences affect pacing but not slide alignment.

## 2.4 Lip-sync for non-English

Lip-sync is **computed client-side in realtime from the audio signal** — the
`_lipsync.json` file written by bake is only a provenance/duration marker
(bake.mjs:4 comment: "the _lipsync.json artifact is an optional marker the
runtime tolerates"). So lip-sync works identically for all six languages — it
is derived from whatever audio plays. The legacy Rhubarb phoneme path is not
in the per-segment bake path.

## 2.5 Missing baked audio at playback

`GET /lecture/segment_audio/:lectureId/:segmentId` (lectureRoutes.mjs:609):
if `segment_NNN.wav` is missing but the `.txt` exists, it synthesizes
**on demand** ("lazy TTS") and caches — student hears silence/spinner for the
duration of one TTS call (+Whisper verify for non-English, up to ~3 attempts
× backoff ≈ several to tens of seconds worst case). If the `.txt` is also
missing → 404 → the client sees a segment-audio error. There is **no
English-audio fallback**; failure is an HTTP error, not silent English.

The `language.change` availability gate (server.js:2062–2078) exists precisely
to keep rooms off this slow path: it refuses switching to a language whose
cache bucket has no `segment_*.wav|txt` at all.

---

# Part 3 — Mid-lecture language switching

## 3.1 Full flow

1. **Client request** — any user opens the Language pill in the top HUD
   (`Scene.jsx:396–434`) → `onLanguage(lang)` → `requestLanguageChange`
   emits `language.change` (`Scene.jsx:973`). The requester does **not**
   switch locally — everyone converges via the broadcast (comment line 970).
2. **Server gate** — `socket.on('language.change')` (server.js:2054):
   - Must be joined (participant in room).
   - If a lecture is running (`ncip.lectureRun`) and lang ≠ 'en', the server
     checks `lecture_cache/segments/<lectureId>__<lang>/` contains at least one
     `segment_NNN.(wav|txt)` — otherwise emits `language-error` back to the
     requester only (room unchanged).
3. **NCIP mutation** — `ncip.changeLanguage(participantId, language)`
   (`ncipRoom.mjs:825`): validates `SUPPORTED_LANGUAGES`, no-ops if unchanged,
   else `this.language.roomLanguage = lang`, retargets any live
   `interruption.checkpoint.language` and `playback.language`, bumps
   `stateVersion`, returns effects:
   `lecture-control { action:'language-change', language, segmentIndex }`
   broadcast room-wide + `floor-state`. `segmentIndex` = canonical checkpoint
   first, else live playback position (lines 845–853).
4. **Agent manifest swap** — `refreshLectureManifest(roomId)` (server.js:1280)
   reloads the run manifest in the new language so the next server-emitted
   segment is already in it.
5. **Each client applies** — `handleLanguageChange` (Scene.jsx:984):
   `planLanguageSwitch(messages, hintSegmentIndex)` (ncipSync.js:160) picks
   the current segment index (local queue head first, server hint as
   fallback; **never seg 0**), fetches
   `GET /api/lecture/segments/<lid>?lang=<lang>`, rebuilds the queue from
   `seg.id >= plan.segmentIndex`, then:
   - queue head is a lecture segment → `stopAudio()` + `replaceQueue(segs)`
     (restart that segment in the new language);
   - an answer/other unit is playing → `replacePending(segs)` (interrupted
     lecture resumes in the new language after it).
   A `langSwitchSeqRef` counter makes the latest switch win so a stale fetch
   can't overwrite a newer queue.

## 3.2 What NCIP stores as position

`ncip.playback = {lectureId, segmentIndex, playbackOffsetMs, language,
reportedAt}` (ncipRoom.mjs:67) — the live frontier reported by clients via
segment-start broadcasts. Plus the canonical `interruption.checkpoint`
(same shape, written once per floor grant) and `recapAnchors` per participant.
Offset precision: `playbackOffsetMs` exists but is **not used** for
cross-language resume (below).

## 3.3 Resume position after switching

**Start of the current segment — not mid-segment.** Cross-language
millisecond alignment is explicitly unsupported (ncipRoom.mjs:813–815
comment: "segments restart from their beginning"). On the client,
`handleLanguageChange` rebuilds the queue *from the current segment's id* and
drops `resumeAt` (Scene.jsx:969 comment). So you lose intra-segment progress
but keep the segment and slide.

## 3.4 Slide behavior

Unchanged side of the switch: slide pages come from the English manifest's
segment `slidePage`/`slideDoc` (language-independent, §1.4), and the rebuilt
queue carries them (Scene.jsx:1011). `resolveSlidePage`/`resolveSlideDoc`
(ncipSync.js:173–188) anchor the board to the current segment's page — so the
slide **stays on the same page** for the restarted segment.

## 3.5 Cross-client synchronization

- Authority: `language.roomLanguage` lives only on the server; all clients
  apply the same broadcast and rebuild from `plan.segmentIndex`, which is
  either their own queue head or the server's `segmentIndex` hint.
- Clock sync (`time.ping`/`time.pong`, `syncLectureClock`) aligns
  `professor-speak` `unitStartedAt` stamps — the normal in-language sync path.
- **Divergence risk (real):** `planLanguageSwitch` prefers the *local* queue
  head over the server hint. A client that is one segment ahead/behind the
  room (drift, jitter) will resume from *its* position, not the room's — two
  clients can legitimately end up one segment apart after a switch. The hint
  only covers the empty/stale-queue case. There is no "seek to room's exact
  position" enforcement on language switch.

## 3.6 Switching during non-LECTURING states

Handled in `changeLanguage` (ncipRoom.mjs:817–824 comments):

- **PAUSED (floor/host pause):** the interruption checkpoint's language is
  retargeted, so the eventual resume comes back in the new language.
  Clients get the broadcast; `handleLanguageChange` no-ops when
  `lectureStatus !== 'teaching'` (Scene.jsx:989) — the change takes effect on
  resume.
- **THINKING/ANSWERING (student question in flight):** the in-flight answer
  **finishes in the original language**; only the subsequent resume switches
  (`replacePending` path). NCIP comment: "the in-flight answer still finishes
  in its original language; only the subsequent resume switches."
- **Catch Me Up recap:** recaps are generated in the *current* room language
  at request time (`resolveRecapMaterial`, lectureRoutes.mjs:831 uses
  `normalizeLang(language)` from the room). A switch mid-recap doesn't
  re-generate — the recap plays out in the language it was requested in
  (same "in-flight unit finishes" rule).

## 3.7 Q&A answers and recaps in room language

**Yes — explicitly locked.** `buildAskPrompt` (lectureRoutes.mjs:638)
instructs: "You must answer ONLY in ${LECTURE_LANGUAGES[lang]} — even if the
question is asked in another language." `lang` is the room's authoritative
language (`ncip.language.roomLanguage`, server.js:2176). Recap route uses the
same room language and synthesizes via `synthesizeVerified(..., lang)`. Also
speech recognition "follows the authoritative room language" for student
voice questions (Scene.jsx:887 comment).

## 3.8 Who can change language

**Any joined participant** — student, guest, host. The socket handler checks
only that the requester is in the room (`rooms[roomId][participantId]`
exists); there is **no role check**. The UI Language pill is rendered for
everyone. Note the pill tooltip still says "applies on next Start Class"
(Scene.jsx:399) while the control actually triggers an immediate
server-mediated switch — stale copy.

---

# Part 4 — Gaps and recommendations

## 4.1 Known bugs / limitations / risks

| # | Issue | Location |
|---|---|---|
| G1 | Empty Ollama output silently keeps the **English** text — a failed translation ships as English audio/text with no marker | `lectureRoutes.mjs:188` |
| G2 | Translated text is never validated as actually being in the target language (only the *audio* is Whisper-checked); a wrong-language translation can be baked | `prepareTranslations` drafts.mjs:398–414 |
| G3 | No technical-term handling — terminology may be translated inconsistently across segments/languages | prompt `lectureRoutes.mjs:185` |
| G4 | Translation is fully sequential (segments × languages × lectures) on CPU Ollama — the dominant build-time cost | `prepareTranslations` loop |
| G5 | Cross-language switch resumes at segment start, dropping intra-segment progress (by design, but noticeable) | `ncipRoom.mjs:813`, `Scene.jsx:969` |
| G6 | `planLanguageSwitch` prefers local queue head → clients at slightly different positions can resume a segment apart; no hard convergence | `ncipSync.js:160–167` |
| G7 | `language.change` permission: any participant (incl. guests) can switch the *room-wide* language for everyone | `server.js:2054` — no role check |
| G8 | Availability gate only checks "at least one segment file exists" — a language with 1 of 20 segments prepared passes the gate, then lazy-translates/TTSes mid-lecture | `server.js:2065–2072` |
| G9 | Lazy manifest path re-translates missing segments sequentially inside an HTTP request — switching to a partly-prepared language can stall | `lectureRoutes.mjs:352–357` |
| G10 | Partial language bakes are recorded (`partial_langs`) but nothing surfaces them to the room/UI beyond the prepare-gate | `bake.mjs:211–221` |
| G11 | Stale UI copy: language pill says "applies on next Start Class" though it applies immediately | `Scene.jsx:399` |
| G12 | Duration band (4–20 min) is English-only; pathological translated audio (e.g. truncated Chinese) is never duration-checked | `bake.mjs:177` |
| G13 | Per-language TTS reference clips (`abed101_<lang>`) only exist if manually registered; otherwise every language clones from the English ref — quality varies | `voxcpmClient.mjs:31–43` |
| G14 | Language list duplicated in 3 files — 'hi' removal had to be applied in each; easy to drift | ncipRoom.mjs:20, lectureRoutes.mjs:166, drafts.mjs:22 |

## 4.2 Ideal mid-lecture switch and required changes

Desired: restart the **same logical segment** in the new language, on the
**server's authoritative position** (not local head), with the slide
unchanged.

Mostly already implemented (segment-restart model is deliberate). To harden:

1. In `planLanguageSwitch`, prefer the server `segmentIndex` hint over local
   head when they disagree by >1 (or always), so all clients converge to the
   room position — change `ncipSync.js:160`.
2. Server: include `playbackOffsetMs≈0` semantics explicitly and emit the
   *authoritative* current segment in the broadcast (already done via hint —
   just make clients obey it).
3. Optionally restart mid-segment by proportional seeking
   (`offset % segmentDuration`) — rejected earlier; only worth it if
   per-language durations are measured and stored per segment
   (`durationMs` is already recorded in `_lipsync.json` markers at bake —
   could be reused to estimate per-language segment durations).

## 4.3 Reducing latency so all languages are ready sooner

- **Parallelize `prepareTranslations`** — translate segments (or languages)
  with bounded concurrency (e.g. `p-queue`, 4–6 workers) instead of the
  sequential loop; Ollama on CPU may still serialize, so the bigger win is
  translating **languages in parallel across processes** or batching multiple
  segments per prompt with a strict `<<<SEG i>>>` output protocol.
- **Translate during English audio bake** — translations don't need TTS; run
  `prepareTranslations` concurrently with the `en` bake inside
  `runAudioPhase`, then verify/bake each language as its translations land.
- **Skip redundant work** — already partially done (`kept-current`,
  `kept-reviewed`, per-segment `.txt`/`.wav` reuse); extend to
  per-segment translation cache keyed by English text hash so editing one
  English segment only re-translates that segment, not the lecture.
- **Pre-warm per-language voices** and use faster Whisper `tiny` for
  `langDetect` (model is configurable via `WHISPER_MODEL`).
- **Optional provider swap** — for build-time translation, allow OpenAI
  (already configured in `courses/llm.mjs`) or a dedicated MT model as an
  alternative to the general `qwen2.5:7b` for speed/quality.

## 4.4 Priorities

**Must-fix**
- G1 silent English fallback on empty translation — fail loudly.
- G8 availability gate too weak (1 file ⇒ "prepared") — require all segments
  or at least `.txt` for every segment.
- G7 permissioning — restrict `language.change` to host/instructor (or make
  it per-client if product wants personal languages).

**Should-fix**
- G6 client divergence on switch — obey server hint.
- G2 validate translated text language (cheap: langdetect or a second Ollama
  check) before writing `translations/<lang>.json`.
- G9 lazy-translate inside manifest request — pre-materialize or cap.
- G14 single source for the language list.
- G11 stale tooltip copy.

**Nice-to-have**
- G3 glossary/term-preservation in the prompt (e.g. "keep technical terms in
  English" or a term list).
- G12 duration checks for non-English with a wider band.
- G13 register per-language reference voices for consistent quality.
- Proportional mid-segment resume using baked per-segment durations.

---

# Part 5 — Manual test cases

**Setup:** run `voxcpm_server.py` (port 8010), Ollama with `qwen2.5:7b`,
backend (`npm run dev`), frontend. Create a course classroom as instructor
with 1–2 PDFs and `lectureCount=1`.

### T1 — Translation generation & segment parity
1. Build the course; when it reaches review, approve scripts → audio.
2. After build `ready`, inspect `profbrain/lectures/<lecId>/translations/`:
   expect `ar.json, fr.json, de.json, es.json, zh.json`.
3. For each file: `segments.length` must equal the English
   `segments.json` count and ids must match 1:1 in order
   (jq: `.segments|map(.id)` equal across files).
4. Confirm `basedOnVersion` equals canonical `version`; spot-read one segment
   per language for sensible translation (watch for English fallbacks — G1).

### T2 — Audio for all languages
1. `ls src/nexora_ai/lecture_cache/segments/` → expect
   `<lecId>` plus `<lecId>__ar`, `__fr`, `__de`, `__es`, `__zh` dirs, each
   with `segment_000.wav`…`segment_NNN.wav`.
2. Play one WAV per language — confirm spoken language matches (spot-check
   Arabic/Chinese especially; verification should have rejected drift, but
   check a clip manually).
3. `SELECT artifacts->'baked_langs' FROM course_lectures WHERE lecture_id=…`
   → expect all 6; check `partial_langs` for any recorded failures.

### T3 — Mid-lecture switch (multi-client)
1. Open the classroom in **two browsers** (or browser + incognito guest).
2. Start the lecture; let it reach segment ≥ 2 so the slide is past page 1.
3. From client A, open the Language pill → pick **العربية (ar)**.
4. Verify on **both** clients within ~1–2 s: HUD language shows العربية; the
   professor restarts the **same segment index** in Arabic (not the next
   segment, not lecture start); slide page unchanged; transcript text is
   Arabic.
5. Mid-lecture, client B switches to **zh** — same checks. Then back to
   **en** — resumes same segment in English.
6. During a floor question (raise hand → professor answering), switch
   language — expected: the answer finishes in the old language; the lecture
   resumes in the new one.
7. While PAUSED (host pause), switch — expected: no audio change now; on
   resume, lecture continues in the new language at the paused segment.

### T4 — Preparedness gate
1. Pick a language not baked for the lecture (or temporarily rename its
   cache dir) → attempt the switch → requester gets a `language-error`
   notice ("…is not prepared for this lecture yet"); room keeps old language.

### T5 — Late joiner
1. Switch the room to `fr` mid-lecture, then join a third client —
   `session.snapshot` should carry `language.roomLanguage='fr'` and playback
   should join at the current segment in French (verifies
   `playback.language` retarget, ncipRoom.mjs:839).

### T6 — English edit invalidation (optional, deep)
1. Re-open the review, edit one English segment, re-approve → check that the
   corresponding `segment_NNN.wav`/`.txt` were deleted in **all six** cache
   buckets and translations show `outdated` (new `basedOnVersion`) until
   re-prepared.
