# Language-switch bug — root cause analysis

Incident: course `957fc478` ("Computer Architecture I — Digital Logic
Circuits Review Part 1", lecture `gen_957fc478_L1`, 9 segments). Started
in English, switched to French (worked), switched to Arabic →
"Arabic is not ready for this lecture yet" and audio stayed French.
Restarting in Arabic "worked".

## Timeline (from server log + file mtimes)

| time (local) | event |
|---|---|
| 09:23 | build `61828551` created |
| 09:26–09:33 | translation phase: ar seg4/7 rejected 3× (script drift: hangul/cyrillic/cjk — foreign-word false positive on "entre"/"aps"), es seg2/3 rejected 3× |
| 09:29–09:41 | audio bake writes `<lang>/segment_*.wav` — ar missing 004/007, es missing 002/003, de missing 005 |
| **09:40:05** | **user joins room `pub_cb578d…`, starts the class — while es seg_008 was still being written (09:41) and before the build finished** |
| 09:43 | build `61828551` marked `ready` ("1 lectures, audio baked in 10.4m") **despite `partial_langs` failures** |

## What the artifacts show

`course_lectures.artifacts` for `gen_957fc478_L1`:
- `baked_langs: ["en","fr","zh"]`
- `partial_langs`: `ar: 2/9 no translated text`, `es: 2/9 no translated text`,
  `de: 1/9 TTS language mismatch`

Filesystem confirms: `gen_957fc478_L1__ar/` has 7/9 wav+txt
(`segment_004`, `segment_007` absent), `__es` 7/9 (`002`,`003` absent),
`__de` 8/9 (`005` absent).

## Root causes (all confirmed in code)

1. **Start is ungated.** `socket.on('lecture.start')` → `startLectureRun`
   loads the manifest and begins. Nothing checks the build state or
   per-language readiness — the class was started ~3 minutes before the
   build finished. The switch gate (`isLanguageReady`) only exists on
   `language.change`.

2. **Build is marked `ready` with missing languages.** In
   `verifyCourseAudio`/`runBuild` (courses/builds.mjs:297–304, bake.mjs
   ~294): per-language errors go to `artifacts.partial_langs` and are
   "non-fatal" as long as English baked (`langsDone.includes('en')`).
   A lecture-level `error` is only set when the English bake fails, so
   `failedAudio` was empty → `setStep(buildId,'ready')` → the classroom
   saw a ready course.

3. **The Arabic rejection was correct behavior** — `isLanguageReady`
   counted `ar` segments on disk: 7/9 (segments 004/007 missing txt+wav)
   → refused → room stayed French. Same for the lecture: it checked
   `gen_957fc478_L1`, the right lectureId, no caching involved
   (filesystem check per call).

4. **"Restart in Arabic worked" is the trap.** `lecture.start` with the
   room language already Arabic has NO readiness check — the manifest
   returned the 7 ready Arabic segments; the 2 missing ones degraded
   silently (English text flagged `pendingTranslation`, no Arabic audio).
   It "worked" only in the sense that Arabic played for most of the
   lecture — exactly the partial behavior the goal forbids.

5. **Utterances are not part of any readiness check** — `isLanguageReady`
   only verifies segment txt+wav; `warmLectureUtterances` failures are
   swallowed (`console.warn`), so an utterance whose TTS drifted (e.g. the
   `fr` transition detected as `pt` in this same build) is missing
   forever and gets regenerated live at runtime — or produces an English
   fallback, which A1 was built to prevent.

6. **No stale-state bug found** in the switch path itself: the broadcast
   `segmentIndex` is authoritative (A2), `language.change` re-runs
   `isLanguageReady` per call, and `changeLanguage` does not corrupt
   `playback`. The perceived "stuck on French" was the gate refusing
   correctly.

## Fix consequences (implemented in this branch)

- Build `ready` ⇔ every lecture ready in all six languages: every
  segment txt+wav **and** all pre-baked utterances; per-language progress
  is surfaced in build status and blocks Start.
- `lecture.start` re-verifies all six languages and refuses with the
  exact per-language reason.
- Readiness now includes pre-baked utterance wavs.
- The classroom language menu only lists languages the server reports
  ready; start is disabled with visible progress until all six are.
