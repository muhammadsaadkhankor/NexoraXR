# Fix Batch 2b Report — live-test issues on `fix/multilingual-batch-2`

Lecture: `gen_18b7cc52_L1` (13 segments).

## ISSUE 1 — Two scripts shown during the lecture

**Component:** the "Lecture script · N segments" panel in
`src/nexora_client/src/classroom/components/ChatInterface.jsx` (rendered from
`lectureScript`, fetched by `Scene.jsx` from `/api/lecture/segments?lang=`).
It sat above the "Live transcript" bubble and showed the whole script —
duplicating the transcript and showing whatever language the client's
`lectureLang` fetch had last resolved (English for late joiners/default state).

**Choice made:** host-only. The panel is now rendered only when
`showLectureScript` is true — `Scene.jsx` passes
`canChangeLanguage` (room owner / INSTRUCTOR / SUPER_ADMIN, the same predicate
as the language-switch permission). Rationale: the panel is useful to the
instructor (full script overview before/during class) but it spoils the
lecture for students and duplicated the transcript. The live transcript is
unaffected: it is fed by the actual playing message objects
(`SpeakingTranscript` + `lectureLines`) which are rebuilt in the room language
by `handleLanguageChange` whenever `language-change` is broadcast — it already
switches language together with the audio.

Commit: `06d1e93` — `fix(ui): hide the Lecture script panel from students`

## ISSUE 2 — Arabic translation quality

### What was wrong

ar.json contained corrupted output the batch-2 validator let through
(it only rejected CJK):

| seg | contamination found |
|---|---|
| 0 | Cyrillic `яв`, Latin `fundamentos` (Portuguese), meaning error `الفيزياء` = "physics" for machine learning |
| 1 | Thai `เข้า` mid-word (`فيเข้ا`) |
| 5 | Latin `procedures` |
| 9 | Cyrillic `нагрузат` (Russian "loads") |

seg 0 came from the temp-0.7 repair draw in batch 2 — the high-temperature
retry had produced worse text than the deterministic failures it replaced.
zh seg 7 had a stray unbracketed English `campaign`. fr/de/es were clean.

### Fixes

**a) Script audit** (commit `0cab4b6`): `scriptAuditReason()` classifies every
letter — ar allows {arabic, latin}, zh {cjk, latin}, fr/de/es {latin};
anything else → `unexpected-script:<name>`; U+FFFD / private-use → `invalid-glyph`.

**b) Foreign-word check** (same commit): `foreignWordReason()` —
ar/zh: every Latin word must appear in the English source (technical terms
kept in brackets) or be an ALL-CAPS ≤5-letter acronym (`ML`, `GPU`); anything
else → `foreign-word:<w>`. fr/de/es: Latin words with another target's
signature diacritics (ñ/¿/¡/á/í/ó/ú/ß/ä/ö/ü per language — `é` exempt in de
for *Café*, `ü` exempt in es for *vergüenza*) or words that are function
words of a different supported language but not the target → rejected.

**c) Meaning check** (commit `7bb15b4`): new `semanticSim.mjs` +
`scripts/e5_similarity.py` — `intfloat/multilingual-e5-small` over
`(source, candidate)` pairs, one model load per language.
`prepareTranslations` sweeps **all** segments (kept + fresh) after each
round; score < `0.78` (`TRANSLATE_SIM_MIN`) unpins the segment for one
regeneration, then it is recorded `low-similarity:<score>` in
`failedSegments`. Calibration on this lecture: correct translations
0.82–0.90, unrelated English text 0.744.

Note: nomic-embed-text was tested first and rejected — it cannot separate
(good ar ≈ 0.42, unrelated en ≈ 0.42).

**d) Temperature cap** (commit `845beb9`): retry schedule `[0.2, 0.5, 0.7]`
→ `min(0.2 + 0.05·(attempt−1), 0.3)`. Segments still failing are `partial`
in the build status — shown to the instructor, never silently accepted.

**e) Re-translation + re-bake**: `prepareTranslations` re-run on
`18b7cc52`: ar segs 1/9 passed on first retry; segs 0/5 needed a second
repair run (the model kept emitting `unexpected-script:cjk` / `foreign-word`
at low temperature — deterministic contamination that eventually cleared);
zh seg 7 regenerated for `campaign`. Re-bake of the 5 purged segments.

### Rejections during the repair runs

```
ar seg0: unexpected-script:cjk ×9 (3 rounds), then accepted on temp-0.2 draw
ar seg5: unexpected-script:cjk ×4, unexpected-script:cyrillic ×1,
         foreign-word:procedures ×1, then accepted
zh seg7: foreign-word:campaign → regenerated clean
semantic rejects: none (lowest final score 0.818 zh)
```

### Similarity scores (multilingual-e5-small, final drafts)

| lang | per-segment scores (13) | min |
|---|---|---|
| ar | .84 .84 .83 .85 .82 .83 .83 .84 .83 .83 .82 .84 .83 | **0.820** |
| fr | .87 .89 .89 .87 .90 .90 .88 .87 .87 .85 .87 .89 .86 | **0.855** |
| de | .87 .87 .86 .86 .87 .88 .86 .86 .85 .84 .84 .86 .84 | **0.837** |
| es | .88 .85 .89 .88 .89 .90 .91 .87 .88 .90 .87 .90 .87 | **0.853** |
| zh | .85 .84 .83 .85 .84 .84 .85 .83 .82 .84 .83 .85 .85 | **0.818** |

Honest caveat: the *bad* ar seg 0 also scored 0.846 — e5 is a drift/topic
check, not a word-level check; the "physics" error was caught by the
script/foreign-word layer, not by (c).

### Final readiness (`isLanguageReady`)

| lang | count | ready |
|---|---|---|
| en, ar, fr, de, es, zh | 13/13 each | all ✅ |

Audio audit (whisper `small`, `detect_language` per 3 s window) on the
re-baked ar segs 0/1/5/9: **every window `ar`**.

### Tests

- `textLangCheck.test.mjs`: 39/39 — new cases: Cyrillic/Thai/U+FFFD in ar,
  `fundamentos` foreign-word, zh acronym allowance, de/es cross-language
  function words, fr ñ rejection; real full-length fixtures still pass.
- `translateRetry.test.mjs`: 4/4 — retry/failure path intact.
- `voxcpmClient.test.mjs`: 8/8.
- Server suite: 347/347 (unchanged code paths).

### Timing

- Repair translation runs: 164 s (run 1: ar 0,1,5,9 + zh 7) + 42 s (run 2:
  ar 0,5 only).
- Re-bake: 324 s total (ar 163 s — 4 segments TTS+detect; others mostly
  cache-hit + utterance warm).

### Not fixed / known limitations

- The utterance-warm path (opening/transition) still produces English audio
  for non-English utterances — rejected by the verifier and skipped, same
  as batch 2. Root cause is in `generateLectureUtterance`, not covered here.
- qwen2.5:7b remains fragile on Arabic: multiple repair rounds were needed;
  a stronger translator model would reduce rejections materially.
- `foreign-word` for fr/de/es catches signature diacritics + cross-language
  function words; an ASCII-only foreign word (e.g. Portuguese "fundamentos"
  inside French) is not catchable word-level — covered only by the semantic
  gate when it shifts meaning.
