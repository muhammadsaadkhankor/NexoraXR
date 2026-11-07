# Segment failure report — gen_14ccda50_L1 (and pipeline hardening)

## What happened

`gen_14ccda50_L1` ("Lecture 1: Introduction", 10 English segments, 978 words,
≈13.6 min measured audio) shipped with two permanently missing translated
segments:

| Segment | Lang | Stored attempts* | Final rejection reason | Verdict |
|---------|------|------------------|------------------------|---------|
| 2 | ar | 4 (3 base + 1 strong-model rescue) | `invalid-language:unexpected-script:other` | **Real error** — the model emitted a letter outside every recognized script (Arabic/Latin/CJK/Cyrillic/Greek/Devanagari/Thai/Japanese/Korean), e.g. an Indic or Syriac glyph glued inside the Arabic sentence. The validator correctly refused to ship it. |
| 6 | zh | 4 (3 base + 1 strong-model rescue) | `invalid-language:foreign-word:machine` | **False positive** — the model wrote `machine learning` (and likely `ML`) in Latin letters inside the Chinese narration, which is standard practice in Chinese technical text. It was rejected because `machine` was not in the English source's Latin vocabulary (the source uses "ML"), and the only exemption was a 2–5-char ALL-CAPS acronym rule. |

\* Rejected candidate text was never persisted (only the per-attempt console
reason in `translateForLecture` and the build-stats `translation_failures`
list), so the exact strings are not recoverable. The draft's `failures` map
now stores the last rejection reason per segment (see fixes below).

English source of the failed segments:

- seg 2: “Machine Learning is a field of study that enables computers to learn
  without being explicitly programmed… called 'learning.' …”
- seg 6: “In the field of electrical engineering, ML is used for load
  prediction… using time-series neural networks to capture complex patterns in
  energy usage.”

## Semantic-similarity calibration

The meaning check (`semanticSim.mjs`, multilingual e5-small cosine on
`query:`/`passage:` prompts) was scored on every accepted baked translation in
`lecture_cache` (n=63 pairs across ar/de/es/fr/zh + 2 verified references)
against a contrast set of cross-lecture mismatched pairs (n=39):

| set | min | p5 | median | max |
|-----|-----|-----|--------|-----|
| GOOD (accepted translations) | 0.759 | 0.787 | 0.853 | 0.920 |
| WRONG (mismatched pairs)     | 0.709 | 0.718 | 0.770 | 0.837 |

Per-language good minimums: ar 0.759 · zh 0.819 · de 0.833 · fr 0.854 · es 0.857.

Conclusions:

- The distributions **overlap** — e5-small cannot separate a same-domain
  mismatch from a real translation (best wrong pair 0.837 > several good ones).
  The gate can only catch *gross* drift (wrong topic / unrelated text).
- The old floor **0.78 rejected verified-good translations** (ar pairs at
  0.759/0.766) while letting most mismatches through anyway.
- New floor: **`SEMANTIC_MIN = 0.74`** — below the observed good minimum with
  margin, still rejects garbage (<0.70). Exact score+threshold is surfaced to
  the UI (`low-similarity:0.612<0.74`).

## Changes made

### Translation validation (`src/nexora_ai/modules/textLangCheck.mjs`)
- Meta-text check now matches **real meta phrases only** (`以下是翻译`,
  `翻译如下`, `译文：`, `继续翻译`, `这是阿拉伯语`, `below is the translation`, …).
  Normal narration vocabulary — `以下`, `继续`, `示例`, `翻译` — no longer trips it,
  and the weak-marker/source-legitimization table was removed entirely.
- Added `TECH_LATIN` allowlist (~150 technical terms and product names:
  `machine learning`, `ML`, `AI`, `Siri`, `Alexa`, `PyTorch`, `GPU`,
  `time-series`, `load`, `prediction`, …) to `isAllowedLatin`, so ar/zh output
  may keep standard Latin technical terms even when absent from the source.
  Genuine foreign bleed (`marketing`, Spanish function words) still rejects.

### Translation pipeline (`src/nexora_ai/routes/lectureRoutes.mjs`,
`src/nexora_server/courses/drafts.mjs`)
- `translateForLecture` accepts `ctx.strongOnly` — the review UI's *Retry
  translation* button goes straight to the strong model (`qwen3:8b`) with 2
  attempts instead of 3 base + 1 rescue.
- The per-segment draft (`translations/<lang>.json`) now persists a
  `failures: {segId: reason}` map with the exact last rejection reason.

### Duration rules — lecture length is content-driven, never a failure
- `shared/languages.mjs`: per-segment safety band is **0.5×–3.0×** English
  duration for **every** language (was 0.6–1.7, zh 0.5–1.3). <0.5× = likely
  truncated, >3× = TTS loop; one rebake retry, then flagged.
- `bake.mjs`: whole-lecture duration is informational only — an out-of-band
  lecture gets a `durationNote`/`audio_offtarget` note, **never** `error`
  (no longer blocks publication).
- `generator.mjs`, `generator2.mjs`, `generator3.mjs`, `generator4.mjs`: all
  word-count/word-band validation problems removed (demoted to `warnings`
  where a target exists); the silent trailing-segment trim in v1 removed.
  Structural checks (empty segments, fragments, missing intro/recap, shallow
  core concepts, duplicates, provenance, admin narration) are unchanged.
- `drafts.mjs` `validateDraftScript`: word bounds removed; empty/blank
  scripts still fail.

### Failure visibility + retry (server + UI)
- `GET /api/lecture/:id/readiness` returns `reason` per failed segment:
  draft `failures` map → `duration_flags` (with the actual ratio) → repair
  record → generic fallback.
- New `POST /api/lecture/:id/segment/:lang/:idx/retranslate` — strong-model
  translation of the English source; writes draft + cache text, clears the
  recorded failure, returns the text for review. Manual editing and
  *Re-bake this segment* are unchanged.
- `CreateClassroomModal.jsx`: each failed segment shows `Reason: …` (exact
  validator reason incl. score/ratio details) and a **Retry translation**
  button alongside the existing edit box + Re-bake button.

### "Possible missing topics" ignores admin content
- `admin.mjs`: new `isAdminTopic()` classifier (grading, group work, office
  hours, exams, deadlines, syllabus, logistics, policies, contacts…).
- Applied at emission (`generator.mjs` artifacts, `generator4.mjs`
  coverage/missing + omitted-topic warnings + uncovered-section check) and
  again in `GET /api/courses/:id/drafts` so **old stored artifacts** (like
  this lecture's “Students are expected to work in groups…”) also stop
  appearing as missing topics.

### Server stability
- `repair.mjs`: fixed `repairIncompleteOnBoot` calling
  `lectureReadiness(lectureId)`/`repairLecture(lectureId)` with an undefined
  variable (`gen_* failed: lectureId is not defined` on every boot) — now
  uses `lecture_id` correctly.

## Test results (unit only — no builds, no course creation)

- `src/nexora_server`: **347/347 pass**
- `src/nexora_ai`: **81/81 pass**
  - `textLangCheck.test.mjs` +6 regression cases (normal `以下` passes,
    `以下是翻译`/`翻译如下` reject, Latin tech terms + product names pass in zh)
  - `voxcpmClient.test.mjs` — fixed 3 stale tests that didn't inject the
    (already-injectable) transcribe second opinion; they spawned real Whisper.
  - `translateRetry.test.mjs` — fixed 2 stale tests that predated the
    strong-model rescue stage (reason string + request count).
  - `bake.test.mjs`, `drafts.test.mjs`, `generator2.test.mjs`,
    `generator4.test.mjs` updated for the info-only duration policy.

## Known remaining notes

- The ar seg-2 failure class (`unexpected-script:other`) is a model-quality
  issue, not a validator bug — the new **Retry translation** button (strong
  model) is the intended manual fix path; `repair` also re-attempts it on
  demand.
- The e5 gate deliberately errs toward accepting translations (distributions
  overlap); Whisper-side audio language verification remains the real
  wrong-language guard.
