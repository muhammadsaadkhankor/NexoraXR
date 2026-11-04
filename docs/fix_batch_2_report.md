# Fix Batch 2 Report — `fix/multilingual-batch-2`

Fixes for the two live-test bugs documented in `docs/bug_investigation_report.md`.
Test lecture: `gen_18b7cc52_L1` (13 segments, course `18b7cc52`).

## Changes per item

### 1. fr/de/es validator — commit `11aed1d`
`src/nexora_ai/modules/textLangCheck.mjs`
- Removed the absolute `ENG_MAX (eng ≥ 0.9)` rule — root cause of Problem B.
- fr/de/es now pass when `francAll`'s **top** candidate equals the target.
- Second signal: `langSignal()` counts target stopwords + diacritics (×2)
  vs English stopwords; text passes only when `signal(target) > signal(en)`.
  The English stopword list excludes tokens that are also legitimate
  fr/de/es words (`a`, `in`, `on`, `es`, `son`, `la`, `die`, ...).
- `<40 chars` rule kept: franc skipped.
- Regression tests use **real** ~800–1000-char Ollama outputs from this
  lecture (fr seg-3, de seg-4, es seg-4) — all pass; the real English
  canonical segment fails for fr/de/es.

### 2. Foreign-script zero tolerance + leaked meta — commit `0163ef3`
- `validateTranslation(text, lang, ctx)`: non-zh text containing **any**
  CJK char → `foreign-script:cjk`; zh containing Arabic script →
  `foreign-script:arabic`.
- `leakedMetaReason()`: strong phrases always reject (`以下是`, `翻译内容`,
  `继续翻译`, `您的翻译`, `示例结束`, `这是阿拉伯语`, `这段话`,
  `below is the translation`, ...). Weak markers (`翻译`, `以下`, `继续`,
  `示例`, `translation`, `translated`, `here is`, `below is`,
  `the following`, `output only`) reject **only when the marker's
  legitimizing word is absent from `ctx.source`** — so a lecture that
  discusses "language translation" can still say "traduction (language
  translation)".
- `translateForLecture` now passes `{ source: text }` to the validator.

### 3. Chat-template translation prompt — commit `a2bc9fa` (+ follow-up in repair commit)
`src/nexora_ai/modules/ollamaClient.mjs`, `routes/lectureRoutes.mjs`
- `generate()` supports `opts.messages` → POST `/api/chat`.
- System message carries all instructions; user message is ONLY
  `<source>…</source>`; model must answer inside `<translation>…</translation>`
  and everything outside the tags is discarded before validation.
- Base temperature 0.2; retries escalate `[0.2, 0.5, 0.7]` because a
  deterministic bad completion needs a different sampling path (needed in
  practice: ar seg-0 failed at 0.2/0.5, passed at 0.7).
- System prompt requests English technical term in brackets on first use
  and explicitly forbids switching language/script.
- `translateRetry.test.mjs` mock updated to serve both `/api/generate` and
  `/api/chat` response shapes.

### 4. Audio verification tightening — commits `659ee62`, `75ce2eb`
`src/nexora_ai/modules/voxcpmClient.mjs`, `langDetect.mjs`
- Any `zh` window in a non-zh clip → reject (zero tolerance).
- General window-match floor raised 60% → 80%.
- Every rejection logs `lecture=… segment=… lang=… attempt=… windows=[…]`;
  `generateSegmentAudio` and the utterance paths now pass
  `{ lectureId, segmentId }` in `opts` so the log has context.
- `detectLanguagesWindowed` now uses encoder-only `detect_language` on the
  padded mel per window instead of `transcribe()` — ~10× cheaper (the old
  path was the dominant detection cost and timed out on CPU), so a larger
  model (`whisper small`) is affordable and mislabels fewer windows.

### 5. Re-validate kept-current drafts — commit `0d05511`
`src/nexora_server/courses/drafts.mjs` (`prepareTranslations`)
- `kept-current` now requires **every** segment to pass
  `validateTranslation` against the current canonical source.
- Segments failing are regenerated individually; their
  `.txt`/`.wav`/`_lipsync.json` cache entries are deleted so they re-bake.
- `edited: true` drafts are never regenerated — invalid segments produce
  status `needs-review` with `failedSegments` ids.

### 6. Partial-language continuation — commit `0e2289c`
- `prepareTranslations` no longer aborts a language on the first bad
  segment: failures are recorded, the rest continues, and the surviving
  segments are persisted so a re-run redoes only the holes.
- Per-language status: `ready` / `repaired` (+`repairedSegments`) /
  `partial` (+`failedSegments`) / `failed` / `kept-current` /
  `kept-reviewed` / `needs-review`.
- `builds.mjs` surfaces `translation_errors`/`translation_failures` with
  status and failed segment ids in the build stats the instructor sees.

### 7. Repair of `gen_18b7cc52_L1`
- `prepareTranslations` re-run: fr/de/es translated fully; ar seg 0 needed
  three repair runs (model kept appending Chinese commentary — rejected
  each time by `foreign-script:cjk`; succeeded on temp-0.7 attempt).
- `verifyCourseAudio` bake: all missing/purged WAVs regenerated.
- **Final `isLanguageReady`: 13/13 for all six languages** (en/ar/fr/de/es/zh).
- Whisper `small` on the re-baked ar segments 0/2/5/8/11: **every window `ar`**
  (was: `zh` blips in 4 of 5).

## Test results

| Suite | Result |
|---|---|
| `textLangCheck.test.mjs` | 30/30 pass (incl. real-paragraph regressions) |
| `voxcpmClient.test.mjs` | 8/8 pass |
| `translateRetry.test.mjs` | 4/4 pass |
| Server suite (`npm test`) | 347/347 pass |

Live end-to-end (item 7): translation report and bake completed; readiness
table above confirmed via `isLanguageReady()`; window-level Whisper audit of
repaired Arabic audio is clean.

## Rejection counts during the repair run

Translation (`prepareTranslations`, all repair runs combined):
- `foreign-script:cjk`: **12** rejections — all on ar seg 0/5/8 (the model
  kept leaking Chinese meta-text until a temp-0.7 draw passed).
- `leaked-meta:translation`: **1** — de seg 5, attempt 1 (passed on retry).
- fr/de/es/zh: zero `english-plausible` / wrong-language rejections —
  the batch-1 false-negative is gone.

Audio (`synthesizeVerified`, bake):
- Segment audio: 1 rejection — `de/2` windows `[es,de,de,de,de,de,fr]`
  (71% < 80%); retry produced clean audio.
- Utterance warms (non-fatal, best-effort): repeated `[en,en]`/`[en]`
  rejections for `ar`, `fr`, `de`, `es`, `zh` opening/transition
  utterances — the LLM-generated utterance text itself is being spoken as
  English by VoxCPM (pre-existing issue in the warm path, see below).

## Timing

Translation (`prepareTranslations`, first repair run):
| lang | ms | note |
|---|---|---|
| ar | 87,483 | 4 segments re-translated (seg 0 failed → partial, repaired later) |
| fr | 118,967 | 13 segments |
| de | 124,779 | 13 segments |
| es | 104,582 | 13 segments |
| zh | kept-current | 0 |
| ar seg-0 repair | ~14–16 s/run × 4 runs | succeeded on 4th |

Bake (`verifyCourseAudio`, total **2,313,993 ms ≈ 38.6 min**):
| lang | ms | note |
|---|---|---|
| en | 68 | all cached |
| ar | 63,918 | 5 re-baked segments |
| fr | 525,521 | 13 segments |
| de | 865,293 | 13 segments |
| es | 838,184 | 13 segments |
| zh | 20,953 | wavs cached; utterance warm only |

Bake time is dominated by CPU Whisper-`small` detection (~7 s/window —
GPU detection is impossible while VoxCPM holds 13.4 GB + Ollama keep-alive
3.2 GB of the 20 GB RTX 4000). Text validation and TTS itself are fast.

## Final readiness (`isLanguageReady`, canonical total = 13)

| lang | readyCount | ready |
|---|---|---|
| en | 13/13 | ✅ |
| ar | 13/13 | ✅ |
| fr | 13/13 | ✅ |
| de | 13/13 | ✅ |
| es | 13/13 | ✅ |
| zh | 13/13 | ✅ |

## Known issues / not fixed

- **Utterance warm produces English audio for non-zh targets.** The
  dynamic opening/transition utterances are LLM-generated; for
  ar/fr/de/es the generated text (or VoxCPM's reading of it) detects as
  `en`/`en,en` and is rejected all 3 attempts → warm skipped. The stricter
  verifier now correctly *refuses* these clips instead of shipping them;
  root cause is likely the utterance-generation LLM writing English text
  for non-English lectures — worth a follow-up batch.
- **qwen2.5:7b Arabic is fragile**: seg-0 needed 9+ attempts across runs
  (temp-0.7 finally passed) and the accepted text is mediocre
  (`يتم تدبيره`, mixed-quality phrasing). A stronger translation model or
  an Arabic-tuned prompt would help; validation ensures bad output is
  never shipped, but repair runs are stochastic.
- **80% window rule vs Whisper noise**: `whisper small` mislabels dropped
  vs `base`, but occasional stray `nl`/`pt`/`ro` windows still occur;
  under the 80% floor a clip can need 1–2 TTS retries. Acceptable, but
  documented.
- CPU detection makes non-English bakes ~10× slower than GPU. Options:
  free VRAM (unload VoxCPM during detection is impossible mid-bake) or a
  dedicated tiny language-id model (e.g. SpeechBrain/ECAPA) instead of
  Whisper.
