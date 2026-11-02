# Fix Batch 1 — Multilingual Hardening Report

Branch: `fix/multilingual-batch-1` (7 commits, one per change, on top of
`final_v`). All measurements on lecture `gen_6bbf922e_L1` — 14 segments,
3 254 chars — with `qwen2.5:7b` on an NVIDIA RTX 4000 Ada (20 GB), while
VoxCPM's vLLM held ~13.6 GB VRAM.

---

## Issue 1 — Empty translation silently fell back to English

**Changed**

- `src/nexora_ai/routes/lectureRoutes.mjs` — `translateForLecture(text, lang, ctx)`
  now runs a 3-attempt loop. Rejected outputs: empty/whitespace, identical to
  source, shorter than the language-aware floor (30% of source chars; 15% for
  `zh` — see note below), or failing `ctx.validate`. After the last attempt it
  throws `Translation failed: lecture=<id> segment=<id> lang=<lang>
  reason=<reason>` and never returns the English text.
- Callers pass `{ lectureId, segmentId }`: `prepareTranslations`
  (`courses/drafts.mjs:417`) and both lazy paths in `loadLectureManifest`
  (`lectureRoutes.mjs:381,387`) — the lazy path can no longer ship English
  silently either.
- `courses/builds.mjs` — `runAudioPhase` records `translation_failures` into
  `course_builds.stats` so rejected translations surface on the build.

**Deviation from spec:** the spec's fixed 30% length floor falsely rejected
valid Chinese output (CJK is denser; measured valid zh translations at
~25–27% of source length). `zh` uses a 15% floor; other languages keep 30%.

## Issue 2 — Translated text never validated as target language

**Changed**

- New `src/nexora_ai/modules/textLangCheck.mjs` — `validateTranslation(text,
  lang)`:
  - `zh`: ≥50% of letters are Han/Kana (CJK) → pass
  - `ar`: ≥50% of letters are Arabic script → pass
  - `fr`/`de`/`es`: `franc-min` (`francAll`) restricted to `[eng,fra,deu,spa]`;
    requires the target language to be the top detection **and** the `eng`
    score to be < 0.9. The extra English-margin rule was added because
    `franc-min` ranked technical English as `fra` at 1.0 vs `eng` 0.98 — a
    bare top-match falsely validated English text as French. Texts <40 chars
    skip franc (caller-side identical-to-English rule still applies).
- Wired as the default content check inside `translateForLecture`'s retry
  loop (dynamic import with no-check fallback); every rejection logs
  `lecture/segment/lang/attempt/reason`.
- Dependency: `franc-min@6.1.0` added to `src/nexora_ai/package.json`.

## Issue 3 — Any participant could change the room language

**Changed**

- `src/nexora_server/server.js` (`socket.on('language.change')`) — before any
  other check: allowed iff `roomRegistry.get(roomId).hostId ===
  participantId` or `socket.data.user.role` is `INSTRUCTOR`/`SUPER_ADMIN`.
  Otherwise emits `language-error` "Only the host can change the classroom
  language." and returns.
- `src/nexora_client/src/classroom/Scene.jsx` — `canChangeLanguage`
  (`isRoomOwner || role INSTRUCTOR|SUPER_ADMIN`) passed to `ClassroomPanel`;
  the pill is read-only for others (no dropdown, tooltip explains), and the
  stale tooltip now reads "changes immediately for everyone in the room".

## Issue 4 — Readiness gate passed with one segment file

**Changed**

- New `src/nexora_server/protocol/languageReady.mjs` —
  `isLanguageReady(lectureId, lang)` → `{ ready, readyCount, total }`.
  `total` = segment count of the canonical English manifest
  (`loadLectureManifest(lectureId,'en')`); a language is ready only when
  every segment has BOTH `segment_NNN.txt` and `segment_NNN.wav` in
  `lecture_cache/segments/<lectureId>__<lang>/`. `en` is always ready.
- `server.js` handler uses it; rejection now reports counts:
  `"Arabic is not ready for this lecture yet (3/14 segments)."`
- Display names for errors in `LECTURE_LANG_LABELS`.

## Issue 5 — Translation on CPU

**Changed**

- `src/nexora_ai/modules/ollamaClient.mjs`:
  - `num_gpu` no longer hard-coded to 0; sent only when env `OLLAMA_NUM_GPU`
    is set (unset → Ollama auto-selects GPU layers).
  - `OLLAMA_TRANSLATE_MODEL` env (default `OLLAMA_MODEL`); translation calls
    pass `translate:true`.
  - Model names starting `qwen3` get `"think": false`.
  - `opts.keepAlive` → `keep_alive` in the request; `translateForLecture`
    sends `keep_alive: "30m"`.
  - New `unloadModel()` — `keep_alive: 0` request evicts the model.
- `courses/drafts.mjs` — `prepareTranslations` uses a bounded worker pool
  (`TRANSLATE_CONCURRENCY`, default 2) over each language's segments, writing
  into fixed-index slots (order/ids unchanged); per-segment and
  per-language (`ms` in report) timings logged.
- `courses/builds.mjs` — `runAudioPhase`: all translations complete →
  `unloadModel()` → only then TTS bake (GPU handoff, no concurrent use).
  `stage_timings` gains `translating_ms` + `translate_per_lang_ms`.
- `env.template.txt` documents `OLLAMA_TRANSLATE_MODEL`, `OLLAMA_NUM_GPU`,
  `TRANSLATE_CONCURRENCY` (match `OLLAMA_NUM_PARALLEL` server-side).

---

## Test results

| # | Test | Result |
|---|---|---|
| 1 | `validateTranslation` unit tests (18 cases: valid zh/ar/fr/de/es pass; English rejected for every target; empty rejected) | ✅ `node --test modules/textLangCheck.test.mjs` 18/18 |
| 2 | Stubbed Ollama: empty output → 3 attempts → throws, never returns source; identical-to-source rejected; 'en' no-call passthrough | ✅ `routes/translateRetry.test.mjs` 4/4 (and nothing written — function throws before any write) |
| 3 | Student/guest `language.change` rejected, host allowed | ⚠️ Code-verified (server check + read-only pill); needs a 2-browser manual pass. Server enforces via `roomRegistry.hostId` + `socket.data.user.role` — guests have no `socket.data.user`, students lack the role. |
| 4 | Deleted `.wav` files → switch refused with counts; restored → works | ✅ `isLanguageReady('gen_6bbf922e_L1','ar')` → `{ready:false, readyCount:0,total:14}`; with 3 fake segments → `{ready:false, readyCount:3, total:14}` → error `"Arabic is not ready for this lecture yet (3/14 segments)."` |
| 5 | Full build of one lecture in 6 languages, counts/ids match | ⚠️ Partial: real translation of all 5 languages ran end-to-end on the live Ollama (all segments passed validation after the zh floor fix). A full `/build`→approve→bake cycle was not run — it needs ~20+ min of TTS; translate path verified, bake path unchanged except ordering. |
| — | Regression suites | ✅ nexora_server 347/347, nexora_client 60/60, nexora_ai 49/50 (1 failure in `voxcpmClient.test.mjs` "mid-segment language blip" — **pre-existing on `final_v`**, unrelated) |

## Before/after translation timings

Test lecture: `gen_6bbf922e_L1`, 14 segments × 5 languages, `qwen2.5:7b`.

| Metric | BEFORE (CPU, sequential, 5m keep-alive default) | AFTER |
|---|---|---|
| ar | 134 873 ms (avg 9 634 ms/seg) | 133 241 ms |
| fr | 143 234 ms (10 231 ms/seg) | 136 226 ms |
| de | 163 342 ms (11 667 ms/seg) | 146 966 ms |
| es | 128 328 ms (9 166 ms/seg) | 70 303 ms |
| zh | 86 249 ms (6 161 ms/seg) | 66 834 ms* → **31 950 ms** after floor fix |
| **Total** | **656 027 ms (~10.9 min)** | **553 571 ms (~9.2 min)** |

\* zh in the "after" run still carried the 30% floor (false rejections on
4 segments burning retries); rerun with the 15% floor: 14/14 passed, 32 s.

**GPU status:** `/api/ps` showed `size_vram: 0` during the run — Ollama
auto-selected CPU because VoxCPM's vLLM holds ~13.6 GB of the 20 GB card and
`qwen2.5:7b` (~5 GB + context) didn't fit the ~4 GB free. This is exactly why
the unload-before-bake ordering was added (and conversely, translate while
VoxCPM is idle cannot use the GPU either). Forcing `OLLAMA_NUM_GPU=12`
partially offloaded (2.3 GB VRAM, one segment in ~5 s vs ~10 s CPU).
The remaining ~10% total speedup came from `keep_alive: "30m"` and avoided
re-synthesis; CONCURRENCY is capped at 2 and Ollama's runner serializes
requests anyway, so the pool mainly overlaps validation/failure handling.

**Hardware:** NVIDIA RTX 4000 Ada Generation, 20 475 MiB; vLLM process
13 660 MiB resident.

## Problems found / not fixed

- `franc-min` misranks technical English as `fra` (score 1.0 vs eng 0.98) —
  mitigated by the eng<0.9 margin rule, but borderline mixed-language text
  may still false-reject; alternatives: stop-word lists or a second Ollama
  classifier call.
- GPU could not be exercised for the headline comparison — VRAM occupied by
  VoxCPM. Re-measure after stopping vLLM (or with `OLLAMA_NUM_GPU≈12` partial
  offload) for the true GPU delta.
- A full instructor→approve→bake cycle wasn't re-run end-to-end; TTS bake is
  unchanged apart from ordering, but an integration pass is recommended.
- Test 3 (student-denied switch) verified by code path, not by a live
  two-browser session.
- Pre-existing failure in `voxcpmClient.test.mjs` (windowed-blip detection)
  exists on `final_v` — unrelated to this batch.
