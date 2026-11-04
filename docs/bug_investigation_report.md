# Bug Investigation Report — Live test on `fix/multilingual-batch-1`

Lecture under test: `gen_18b7cc52_L1` (course `18b7cc52-97d5-4994-b91e-d2fcd3ac15b1`, 13 canonical segments).
Investigation only — no code was changed.

---

## PROBLEM A — Professor speaks Chinese for a few seconds inside the Arabic lecture

### 1. Does the Arabic text contain Chinese? — YES (confirmed)

`profbrain/lectures/gen_18b7cc52_L1/translations/ar.json` contains literal CJK
runs in **5 of 13 segments** (ids 0, 2, 5, 8, 11). The identical text is mirrored
into `src/nexora_ai/lecture_cache/segments/gen_18b7cc52_L1__ar/segment_00{0,2,5,8}.txt`
and `segment_011.txt`. Examples:

- seg 0 tail: `...عام 1959.将在下面继续您的翻译。` ("will continue your translation below")
- seg 2: `...للكمputers تعلم而不输出完整翻译，是因为需要按照要求只输出翻译内容...` — the model
  echoes its own instructions in Chinese mid-sentence ("...because output must follow the
  requirement to only output translated content, keeping spoken style and length. Below is the translation:")
- seg 8: `...اليومية. 示例结束，这是阿拉伯语翻译的部分：` ("example ends, this is the Arabic translation part:")
- seg 11: `...تقليد الوظائف認知已中断，让我继续用阿拉伯语翻译这段话...` ("cognition interrupted, let me continue translating this in Arabic")

So this is **not TTS drift**. The qwen2.5:7b translation itself leaked Chinese
meta-commentary / self-instructions into the Arabic output, and VoxCPM faithfully
read the Chinese characters aloud for a few seconds, then continued in Arabic —
exactly the observed symptom.

### 2. Whisper windowed detection on the Arabic WAVs

`detectLanguagesWindowed` (3 s windows, whisper `base`) on the cache WAVs:

| segment | per-window languages | match rate |
|---|---|---|
| 000 | `ar ar ar ar zh` | 4/5 = 80 % |
| 002 | `ar ar zh ar ar ar ar ar ar ar ar ar ar ar` | 14/15 = 93 % |
| 005 | `ar ar ar ar zh` | 4/5 = 80 % |
| 008 | `ar ar zh ar ar ar ar ar ar ar ar ar ar ar ar ar ar ar ar ar ar ar` | 20/21 = 95 % |
| 011 | `ar ×20` | 100 % (TTS garbled/skipped the CJK, or Whisper mislabels it as ar) |

The `zh` windows sit exactly where the CJK text appears in each segment.

### 3. Why these clips passed audio verification

`src/nexora_ai/modules/voxcpmClient.mjs` → `synthesizeVerified`, lines 108-113:

```js
const ok = Array.isArray(detected)
  ? detected.filter((l) => l === lang).length >= Math.ceil(detected.length * 0.6)
  : detected === lang;
```

The rule accepts a clip when **≥60 % of windows match the target**. A single 3 s
Chinese blip inside a 15–45 s Arabic clip scores 80–95 % — comfortably above the
threshold. The 60 % tolerance was added because Whisper occasionally mislabels one
window; here it tolerates genuinely foreign-language windows too.

### 4. Is an Arabic reference voice registered? — YES

`voxcpm_data/voice_registry.json` contains `abed101_ar` with an Arabic
`prompt_text`; `refForVoice('abed101','ar')` in `voxcpmClient.mjs:31` resolves it.
Arabic audio was **not** cloned from the English voice. Voice selection is not
implicated.

### Root cause (CONFIRMED)

The Ollama translator emitted Chinese meta-text inside Arabic translations for
this lecture (generated **before** the batch-1 validation existed — `ar.json` has
`version:0, basedOnVersion:0, edited:false` and contains CJK). The contaminated
text was baked to WAV, and `synthesizeVerified`'s 60 %-window tolerance passed
clips containing one 3 s Chinese window each.

Responsible code:

- Contamination origin: `translateForLecture` in `src/nexora_ai/routes/lectureRoutes.mjs:191` (pre-fix output; the prompt produces model drift).
- Acceptance rule: `synthesizeVerified` in `src/nexora_ai/modules/voxcpmClient.mjs:111`.
- Remaining gap in batch-1 validation: the Arabic check in `textLangCheck.mjs:37-41` requires only ≥50 % Arabic-script letters. Seg 2 (majority-CJK) would now be **rejected**, but segs 0/8/11 (mostly Arabic with a CJK tail) would still **pass** — small CJK contamination is not caught by either layer.

### Suggested fix (not implemented)

1. In `textLangCheck.mjs`, reject Arabic translations containing *any* CJK
   character above a tiny count (e.g. >2 CJK chars → fail) — script-mixing inside
   Arabic is never legitimate.
2. In `synthesizeVerified`, tighten the window rule for non-English: reject if
   any window is a *confidently different* language family (or simply raise the
   match floor to 100 % for ar/zh where Whisper is reliable), rather than 60 %.
3. Re-translate `gen_18b7cc52_L1` ar under the new validator and re-bake
   segments 0, 2, 5, 8, 11.

---

## PROBLEM B — "Spanish/French/German is not ready for this lecture yet"; ar and zh work

### 1. Exact readiness counts and files on disk

`isLanguageReady` counts `segment_NNN.{txt,wav}` pairs against the canonical 13:

| lang | readyCount/total | txt files | wav files |
|---|---|---|---|
| ar | 13/13 ready | 13 | 13 |
| zh | 13/13 ready | 13 | 13 |
| de | 4/13 | `segment_000–003.txt` | 0 |
| es | 4/13 | `segment_000–003.txt` | 0 |
| fr | 3/13 | `segment_000–002.txt` | 0 |

`profbrain/lectures/gen_18b7cc52_L1/translations/` contains only `ar.json` and
`zh.json` — **no es/fr/de.json was ever produced**.

### 2. Did translation fail? — YES (DB evidence)

`course_lectures.artifacts` for `gen_18b7cc52_L1`:

```json
"baked_langs":   ["en","ar","zh"],
"partial_langs": [
  "fr: Translation failed: lecture=gen_18b7cc52_L1 segment=3 lang=fr reason=invalid-language:english-plausible(eng=0.91)",
  "de: Translation failed: lecture=gen_18b7cc52_L1 segment=4 lang=de reason=invalid-language:english-plausible(eng=0.94)",
  "es: Translation failed: lecture=gen_18b7cc52_L1 segment=4 lang=es reason=invalid-language:english-plausible(eng=0.92)"
]
```

The partial `.txt` files on disk match exactly: fr wrote segs 0-2 then died on
seg 3; de/es wrote segs 0-3 then died on seg 4 (per-segment `.txt` persistence is
from `loadLectureManifest`'s lazy path, `lectureRoutes.mjs:390-395`, which writes
each translated segment before the next one throws).

### 3. Every validateTranslation rejection (live reproduction)

Re-running `translateForLecture` on the same canonical segments reproduced the
rejections deterministically — **every attempt, every language**:

```
fr seg3: attempt 1/2/3 all rejected → english-plausible(eng=0.91 / 0.91 / 0.92)
de seg4: attempt 1/2/3 all rejected → english-plausible(eng=0.93 / 0.94 / 0.93)
es seg4: attempt 1/2/3 all rejected → english-plausible(eng=0.92 ×3)
```

### 4. Is the franc `eng < 0.9` margin rejecting valid translations? — YES (confirmed root cause)

Captured raw Ollama output for fr seg 3 is **fluent, correct French**
("L'apprentissage automatique est un domaine d'étude qui permet aux ordinateurs
d'apprendre sans être programmés explicitement…", 1021 chars):

```
francAll(out, {only:[eng,fra,deu,spa]})
→ fra:1.000  spa:0.922  eng:0.912  deu:0.902
```

franc's `francAll` scores are trigram-similarity scores, not calibrated
probabilities. With `only` restricted to four Latin-script languages, **all**
candidates score high on a full paragraph of fluent Latin-script text — English
routinely exceeds 0.90 even when French is the clear winner (fra = 1.000).

The batch-1 rule in `src/nexora_ai/modules/textLangCheck.mjs:56`:

```js
if ((scores.eng ?? 0) >= ENG_MAX)   // ENG_MAX = 0.9
  return { ok:false, reason:`english-plausible(eng=…)` };
```

rejects the translation even though `detected === 'fra'` passed on line 53.
Absolute `eng ≥ 0.9` is guaranteed to fire on normal-length French/German/Spanish
prose — it's a systematic false negative, not a marginal one. (On short/technical
texts eng stays lower — earlier unit tests on ~200-char samples showed eng ≈ 0.78 —
which is why the unit tests passed but the real full-paragraph segments fail.)

The retries then make it *look* worse: the model re-generates a correct
translation 3 times, each is rejected for the same validator bug, the language is
marked `failed`, and the whole language is skipped — so es/fr/de were never fully
baked. The readiness gate added in batch 1 then correctly refuses the switch
("not ready … 4/13") — the readiness error is a symptom, not the bug.

### 5. Why did ar and zh pass?

They never go through franc. `textLangCheck.mjs` uses script-fraction checks for
`zh` (≥50 % CJK) and `ar` (≥50 % Arabic script) — a different, correctly working
code path that only failed *this* lecture's ar in the contamination case (which
predates validation). `fr/de/es` are the only languages routed through the broken
`ENG_MAX` margin rule.

### Root cause (CONFIRMED)

Bug introduced in batch 1, issue 2: the `english-plausible(eng ≥ 0.9)` margin in
`validateTranslation` rejects valid full-length fr/de/es translations because
`francAll` assigns `eng > 0.9` to essentially any fluent Latin-script paragraph.
Responsible code: `src/nexora_ai/modules/textLangCheck.mjs:56-58` (rule), invoked
from `translateForLecture` `lectureRoutes.mjs:220`; failure surfaced via
`prepareTranslations` in `src/nexora_server/courses/drafts.mjs:423-430` →
`partial_langs`, and blocked at runtime by `isLanguageReady` in
`src/nexora_server/server.js`.

### Suggested fix (not implemented)

1. Drop the absolute `ENG_MAX` threshold. Require only that the **top** franc
   candidate equals the target (line 53 already does this); optionally keep a
   *relative* guard, e.g. `scores.eng < scores[target]` (top score is always
   1.0, so this reduces to top-match) or `scores.eng < 0.9 * scores[target]`.
2. Alternatively replace franc-min for this check with a stopword/diacritic
   heuristic — French/German/Spanish are distinguishable by `ç/à/é`, `ß/umlauts`,
   `ñ/¿/¡` plus function words — which is deterministic and cheap.
3. Add a regression test: validateTranslation must accept a ~800-char real
   French paragraph (the captured seg-3 output above is a perfect fixture).
4. After the fix, re-run translation for es/fr/de on `gen_18b7cc52_L1` to fill
   the missing `.json` files, then re-bake their audio.

---

## Cross-problem note

Both problems trace to the same underlying weakness: qwen2.5:7b translation
output quality/identity is unreliable (Chinese leakage into ar; the validator bug
then punished the *good* outputs for fr/de/es). One symptom was text-side, the
other validator-side — they are independent bugs, not one root cause.
