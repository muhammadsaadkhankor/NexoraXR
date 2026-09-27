# Teaching Pipeline Implementation Report

## 1. Summary

The classroom teaching pipeline was completed and stabilized for the Multimedia course. The
classroom now has a single right-side control panel that shows the active course, the active
lecture (resolved from the `?lecture=` URL parameter), a stateful Start Class button, and the
existing avatar/camera/chat/settings controls.

Lecture content is served through a new segment-based endpoint. For each lecture the backend
builds a small manifest of teaching segments. Each segment contains the spoken text, a speech
audio file, Rhubarb lip-sync data (when generation succeeds), an animation name, and a facial
expression. The frontend queues all segments into the existing `useSpeech` message queue, so
the professor avatar plays them sequentially with the existing audio/animation/expression/lip-sync
behavior.

## 2. Files Changed

```text
src/backend/lectureRoutes.mjs
src/frontend/src/Scene.jsx
src/frontend/src/components/Avatar.jsx
src/frontend/src/components/SettingsPanel.jsx
src/frontend/src/hooks/useSpeech.jsx
```

Prepared segment assets are cached under:

```text
src/backend/lecture_cache/segments/Lecture_<n>/segment_<i>.wav
src/backend/lecture_cache/segments/Lecture_<n>/segment_<i>_lipsync.json
```

## 3. Classroom UI

The left course panel and the old top-right control cluster were replaced by a single
right-side `ClassroomPanel` in `src/frontend/src/Scene.jsx`. It shows:

```text
Multimedia
Multimedia Computing
Lecture 04

[ Class in Progress ]

Avatar | My Avatar
Camera | Chat
Settings
```

The Start Class control uses a local teaching state (`idle`, `loading`, `teaching`, `completed`,
`error`) and disables repeated clicks while a lecture is loading or playing. An error state
displays a readable message instead of `alert()` and does not unmount the Three.js scene.

## 4. Lecture Selection Flow

```text
CoursePage -> /scene/Multimedia?lecture=Lecture_<n>
          -> Scene.jsx reads useSearchParams().get('lecture')
          -> handleStartClass() fetches /api/lecture/segments/:lectureId
          -> backend resolves the lecture and returns a manifest
          -> frontend queues segments into useSpeech
          -> Avatar plays each segment in order
```

The URL is the source of truth: `/scene/Multimedia?lecture=Lecture_4` shows `Lecture 04`
in the right panel and requests the `Lecture_4` manifest. When `lectureId` changes, the
teaching state is reset to `idle` and any queued speech is cleared.

## 5. Teaching State

The Start Class button renders:

```text
idle      -> [ Start Class ]
loading   -> [ Loading Lecture... ]   (disabled)
teaching  -> [ Class in Progress ]   (disabled)
completed -> [ Replay Lecture ]
error     -> [ Retry Class ] + error message
```

Completion is detected when the speech queue drains to zero after teaching started.

## 6. Profbrain Pipeline

The existing `profbrain/lectures/Lecture_<n>/` assets are reused:

```text
lecture_notes.txt / chunks.json / summary.json
summary.wav / lipsync.json (pre-generated where present)
```

`summary.json` was produced offline by `profbrain/prep_lectures.py` (PDF/text extraction,
cleanup, then an Ollama summary). `summary.wav`/`lipsync.json` were produced by
`prep_tts.py` (CosyVoice + Rhubarb).

At runtime, `GET /api/lecture/segments/:lectureId` either:

- returns the existing whole-lecture `summary.wav`/`lipsync.json` as a single segment
  (currently `Lecture_1`), or
- splits `summary.json` into shorter text segments, generates `segment_<i>.wav` via CosyVoice
  and `segment_<i>_lipsync.json` via Rhubarb, and caches them in
  `src/backend/lecture_cache/segments/<lectureId>/`.

Subsequent requests use the cached files and return immediately.

## 7. Lecture Segment Format

Endpoint `GET /api/lecture/segments/:lectureId` returns:

```json
{
  "lectureId": "Lecture_4",
  "title": "Multimedia Computing: Multimedia Interactions",
  "segments": [
    {
      "id": 0,
      "title": "Multimedia Computing: Multimedia Interactions",
      "text": "Multimodal interaction refers to...",
      "animation": "explain",
      "facialExpression": "smile",
      "audioUrl": "/api/lecture/segment_audio/Lecture_4/0",
      "lipsync": { "mouthCues": [...] }
    }
  ]
}
```

The frontend expands `audioUrl` to the full backend origin before pushing each segment into
`useSpeech`.

## 8. Audio and Lip Sync

Each segment is checked against the cache. If `segment_<i>.wav` and
`segment_<i>_lipsync.json` exist, they are reused. Otherwise the backend calls CosyVoice
(`getDefaultVoice('abed101')` + `synthesize`) for the WAV and `./bin/rhubarb -f json -r phonetic`
for lip-sync data. Files are written to `src/backend/lecture_cache/segments/<lectureId>/` so
the next Start Class is instant.

A small text sanitizer (`cleanTextForTts`) strips markdown emphasis, leading bullet markers,
leading numbered-list markers, and square-bracket citations before synthesis because CosyVoice
terminated when `[...]` references were left in the text. TTS generation is retried up to three
times per segment; a failed lip-sync parse is tolerated (the segment still plays audio).

## 9. Sequential Playback

`handleStartClass` pushes every returned segment into the shared `useSpeech` queue in order.
`Avatar.jsx` plays the current segment's `audioUrl` and calls `onMessagePlayed` when the
audio ends (or errors). `onMessagePlayed` pops the queue, which promotes the next segment and
changes the animation/expression/lip-sync accordingly. When the last segment finishes the
queue becomes empty and the panel switches to `completed` / `Replay Lecture`. Leaving the
scene (route unmount or lecture change) clears the speech queue and pauses the current audio,
so the lecture does not continue after exiting the classroom.

## 10. Testing Results

| Test | Result |
|---|---|
| Frontend build (`npm --prefix src/frontend run build`) | PASS |
| Lecture 1 selection (`GET /api/lecture/segments/Lecture_1`) | PASS |
| Lecture 1 playback assets | PASS (uses existing `summary.wav`/`lipsync.json`) |
| Lecture 4 selection (`GET /api/lecture/segments/Lecture_4`) | PASS |
| Lecture 4 playback assets | PASS (26 segments, all `segment_*.wav` present) |
| Lecture 8 selection (`GET /api/lecture/segments/Lecture_8`) | PASS |
| Lecture 8 playback assets | PASS (18 segments, all `segment_*.wav` present) |
| Sequential segments | Implemented; verified via the speech queue and generated manifests |
| Duplicate Start protection | Implemented (button disabled outside idle/completed/error) |
| Completion state | Implemented (queue empty -> `completed` / `Replay Lecture`) |
| Missing asset handling | PASS (missing/failed lecture returns HTTP 500 and shows a UI error; scene stays mounted) |

## 11. Lecture Coverage

```text
Lecture_1: TESTED  (existing whole-lecture summary.wav + lipsync.json)
Lecture_2: GENERATED (21 segments)
Lecture_3: GENERATED (19 segments)
Lecture_4: TESTED  (26 segments)
Lecture_5: GENERATED (38 segments)
Lecture_6: GENERATED (23 segments)
Lecture_7: GENERATED (16 segments)
Lecture_8: TESTED  (18 segments)
```

"GENERATED" means the manifest and per-segment audio/lip-sync were produced and returned
by the API; "TESTED" means the endpoint was exercised during verification.

## 12. Known Limitations

- `Lecture_1` still uses the original monolithic `summary.wav`/`lipsync.json`; its prepared
  assets are whole-lecture rather than per-segment.
- Segment splitting is a simple paragraph/sentence heuristic, so segment counts are uneven
  (e.g., `Lecture_5` produces 38 segments).
- A few `segment_<i>_lipsync.json` files may be absent or unparsable when Rhubarb fails; the
  segment still plays audio but without lip-sync (observed for `Lecture_4` segment 20).
- The first request for an unprepared lecture runs CosyVoice/Rhubarb synchronously and can
  take a minute or two; cached lectures are fast. A future offline `prep_segments` script
  should generate these assets ahead of class.
- Question/pause/resume behavior is intentionally not implemented; the queue is segment-based
  and ready for that next step.
