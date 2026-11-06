# Fresh-course build failure — investigation report

Run under investigation: `e2e/fresh_course_build.test.mjs 2`, log `/tmp/fresh2.log`.
Course `26e63ddc-9ac5-4b1f-9881-fb5d84f2e125`, lecture `gen_26e63ddc_L1`,
build `24b4e8fc-3b6a-44a3-8f84-5a6d783b220d`.

## 1. Why the build went back to `awaiting_review`

**It was not a translation, TTS or verification failure. It was a second
`runBuild` for the same build row, executing in a different process.**

Evidence chain:

| Time (UTC) | Event | Source |
|---|---|---|
| 17:20:10 | test server starts, PORT=3010 (PID 916874) | `/proc/916874/environ` |
| 17:21:13 | build row created, `status='scripts'` | `course_builds.created_at` |
| 17:21:24 | **user's nodemon dev server on :3000 restarts (PID 960204)** | `ps -eo lstart`, `/proc/960204/environ` |
| 17:26 (t=357s) | test sees `awaiting_review`, calls `approve-audio`; status → `audio` | `[course] build 24b4e8fc awaiting review` |
| 17:26–17:43 | audio phase prepares translations | `[translate] …` lines |
| 17:44:36 | **`course_lectures` row for `gen_26e63ddc_L1` re-created** | `course_lectures.created_at` |
| ~17:45 (t=1472s) | status reads `awaiting_review stage=scripts progress=1/1` | poll line 113 |
| t=1502s | status back to `audio … AR` — bake continues | poll line 115 |

The dev server restarted (nodemon watches `js,mjs`; the test file edit
triggered it) **11 seconds after** the build row appeared with
`status='scripts'`. On boot it runs `resumeInterrupted()`:

- `src/nexora_server/courses/builds.mjs:343-359` selects every build
  `WHERE status NOT IN ('ready','failed','awaiting_review')`.
- `status='scripts'` is neither audio nor translating, so it dispatched
  **`runBuild`** — a full re-run of script generation for a build that the
  test server was already running.

That duplicate `runBuild`:

1. Regenerated the lecture script from scratch (17:21:24 → 17:44:36) while
   the first process was translating/baking the *approved* script.
2. Re-emitted the lecture (`emitLecture`) at 17:44:36, **overwriting
   `segments.json`** — the manifest went from **8 segments to 16**.
3. Wrote its terminal `setStep(buildId,'awaiting_review',{stage:'scripts'})`
   (`builds.mjs:184`), clobbering the live `audio` status. `setStep` merges
   stats (`stats || patch`), so `stage` became `scripts` while `progress`
   kept the stale `1/1` from `builds.mjs:176` — exactly the observed line.

Two concrete bugs:

- **B1 — no cross-process mutual exclusion.** `running` (a `Map`) is
  per-process only. Two servers on one DB happily run the same build.
- **B2 — `setStep` allows backwards transitions.** A late write from a
  stale runner can move `audio`/`validating`/`ready` back to
  `awaiting_review`.

Consequence: the approved English script and all audio baked against it
were invalidated mid-flight. No individual language/segment "failed" — the
ground truth moved underneath the bake.

## 2. Is this the "show failing segment to the instructor" path?

**No.** That path is `verifyCourseAudio` → `status='failed'` with
`stats.stage` in `translations|audio|validating`, and readiness exposing
`failed[]` (EN + translation text). This run never reached `failed`; it
stayed `audio` and kept baking.

However the user's point stands for the test harness: the build-status
poller had **no no-progress timeout**, so it would have waited forever on
any parked state. Fixed — see §6.

## 3. Per-language readiness at the moment of investigation

`lectureReadiness('gen_26e63ddc_L1')` → `allReady: false`

| lang | segments | utterances | missing segments |
|---|---|---|---|
| en | 16/16 | 1/12 | — |
| ar | 7/16 | 0/12 | 6, 8–15 |
| fr | 8/16 | 0/12 | 8–15 |
| de | 8/16 | 0/12 | 8–15 |
| es | 0/16 | 0/12 | 0–15 |
| zh | 0/16 | 0/12 | 0–15 |

Read this as proof of the corruption, not of bake failure: the counts are
measured against the **new 16-segment** manifest, while the audio that
exists was baked for the **old 8-segment** script (hence fr/de at exactly
8/16). The utterance plan likewise grew from 4 to 12 keys, zeroing the
utterances already baked.

## 4. The 8 rejected / rescue events

Translation rejections (all Arabic, all recovered):

| segment | attempts | reasons | outcome |
|---|---|---|---|
| 1 | 1/3 | `unexpected-script:cyrillic` | passed on attempt 2 |
| 4 | 1/3 | `foreign-word:changing` | passed on attempt 2 |
| 6 | 1/3, 2/3, 3/3 | cyrillic, cyrillic, cjk | 3 normal attempts failed |
| 6 (2nd round) | 1/3, 2/3, 3/3 | cyrillic, cjk, cyrillic | retry round also failed |

Segment 6/ar exhausted both retry rounds. It never reached the stronger
`qwen3:8b` fallback in this run because the surrounding build was already
corrupted; the fallback is in place (`lectureRoutes.mjs`, verified working
on `gen_957fc478_L1` seg 4/ar: `strong-model rescue … model=qwen3:8b`).

TTS verification rejections:

| clip | windows | outcome |
|---|---|---|
| ar/1 | 22× `ar` ≥0.69, final window `pt@0.977` | retried |
| es/0 | `it@0.711` / `it@0.742` (×3 attempts) | the known ref-clip accent drift |
| es/1 | `it@0.995`, later `it@0.947`+`it@0.702` | retried |

No `rescue` (sentence-split / noRef) lines appear in this log: the run was
killed during the ES pass before the rescue chain was reached. The chain
itself is proven on `gen_25e89fdc_L1` (`sentence-split rescue … (6 parts)`,
`(5 parts)`, plus noRef for single-sentence segment 0 → `ready: true`).

## 5. Timing

Stage wall-clock (from the test's own poll stamps):

| stage | window | duration |
|---|---|---|
| ingest + plan | 0 → 62s | 62s |
| script generation | 62 → 357s | 295s |
| translations (inside audio phase) | 357 → 1382s | **1025s (17.1 min)** |
| bake EN | 1382 → 1502s | 120s |
| bake AR | 1502 → 1623s | 121s |
| bake FR | 1623 → 1773s | 150s |
| bake DE | 1773 → 1863s | 90s |
| bake ES | 1863s → killed | — |

Per-language translation (sum of per-segment `[translate]` timings):

| lang | n | total | avg | max |
|---|---|---|---|---|
| ar | 7 | 166s | 23.8s | 39.7s |
| fr | 8 | 119s | 14.8s | 19.5s |
| de | 8 | 119s | 14.9s | 19.6s |
| es | 8 | 104s | 13.0s | 16.9s |
| zh | 8 | 62s | 7.8s | 10.0s |
| **all** | 39 | **570s (9.5 min)** | 14.6s | 39.7s |

Interpretation of the slowness:

- Actual translation work was 570s, but the stage took 1025s — **~455s
  (44%) lost**, consistent with the duplicate `runBuild` generating a whole
  lecture script against the same Ollama instance for 23 minutes.
- Arabic is the slowest language (23.8s avg) because it retried most.
- Whisper language verification runs on **CPU** (`[lang-detect] whisper
  service ready (cpu)`). `pick_device()` requires >7 GiB free VRAM and the
  GPU showed ~14.8 GiB already used by VoxCPM/vLLM, so it stays on CPU.
  Each verified clip pays a 3s-window pass per window plus, now, a
  transcribe second opinion for confident-foreign windows — the dominant
  per-clip cost in the bake stages above.

## 6. Fixes applied

- **B1** — `runBuild` / `runTranslationPhase` / `runAudioPhase` now take a
  Postgres advisory lock on the build id and exit immediately if another
  process holds it; `resumeInterrupted` additionally skips builds touched
  in the last 10 minutes (a live runner is on them).
- **B2** — `setStep` refuses backwards transitions: a write of an earlier
  phase is ignored when the row is already in a later phase.
- **Test harness** — every wait now has a no-progress watchdog: if neither
  `build.status` nor `stats.progress` changes for 10 minutes the test
  stops and reports, instead of polling forever. A `failed` build with
  per-segment detail is reported and terminated immediately rather than
  waited on.
- Per the user's instruction, the verification plan is reduced to **one**
  fresh course end-to-end until build speed is addressed.

Residual (not fixed here): Whisper verification on CPU is the main bake
cost; moving it to GPU requires freeing VRAM from VoxCPM/vLLM first.
