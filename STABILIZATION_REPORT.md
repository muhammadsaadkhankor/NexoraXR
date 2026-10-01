# Stabilization Report — NexoraXR

Surgical stabilization pass over the codebase. Six targeted areas were fixed:
the broken `POST /sts` route, `ContinuousRecorder` audio duplication, React
hooks ordering in `Scene.jsx`, stale launcher paths, hardcoded backend URLs,
and dead/commented legacy code inside the touched files only. No unrelated
behavior, UI, lecture logic, social interaction, avatar logic, TTS, or RAG
code was modified.

---

## 1. Files changed

| Path | Reason |
|---|---|
| `src/backend/server.js` | Removed `/sts` route + ~445 lines of commented legacy server versions + commented `/transcribe` block + dead `whisper.mjs` import |
| `src/frontend/src/components/ContinuousRecorder.jsx` | Passive recorder fix + removed ~720 lines of commented iterations |
| `src/frontend/src/Scene.jsx` | Hooks-ordering fix (split `Scene`/`SceneRoom`) + 3 `API_URL` call sites |
| `src/frontend/src/hooks/useSpeech.jsx` | `backendUrl` → `API_URL`, removed dead `sendAudioData` + 145-line commented legacy block |
| `src/frontend/src/components/Scenario.jsx` | `SLIDE_API_BASE` → `API_URL` |
| `src/frontend/src/components/SettingsPanel.jsx` | 3 fetches → `API_URL` + removed commented legacy blocks |
| `src/frontend/src/components/LecturePicker.jsx` | 2 fetches → `API_URL` |
| `src/frontend/src/services/lectureApi.js` | `API_BASE`/`audioUrl()` → `API_URL` |
| `src/frontend/src/config.js` *(new)* | Single `API_URL` export with `VITE_API_URL` override |
| `src/frontend/.env.example` *(new)* | Documents `VITE_API_URL=http://localhost:3000` |
| `src/frontend/.gitignore` | Added `.env` |
| `run_app.sh`, `cosyvoice_tts.sh`, `docker-compose.yml` | `backend/`→`src/backend`, `frontend/`→`src/frontend`; log paths → `../../logs`; compose `VITE_API_URL` 5000→3000 |

---

## 2. Fixes completed

### Fix 1 — `POST /sts`

- **Root cause**: the route called `convertAudioToText`, but
  `src/backend/modules/whisper.mjs` is entirely commented out — the function
  does not exist, so any request would crash the handler.
- **Fix**: removed the route and its dead commented import.
- **Why minimal**: the only frontend caller (`sendAudioData` in
  `useSpeech.jsx`) was defined but never invoked — mic `onstop` only stores
  the blob and hold-to-talk uses the browser Web Speech API
  (`transcribeAudio`). Repairing would have required re-introducing the
  OpenAI Whisper cloud dependency, which was prohibited.
- **Runtime behavior**: unchanged — nothing actively called `/sts`. The
  endpoint now returns a controlled `404`.

### Fix 2 — `ContinuousRecorder` audio duplication

- **Root cause**: on each message the recorder created its own
  `new Audio("data:audio/mp3;base64," + message.audio)` and called `play()`,
  while `Avatar` simultaneously plays the same message through the shared
  `audioElementRef` — professor speech played twice (echo) and the recorder
  even called `onMessagePlayed()`, racing the queue dequeue.
- **Fix**: the recorder is now passive. It taps `audioElementRef.current`
  via `el.captureStream()` / `el.mozCaptureStream()` and adds only the audio
  *tracks* to the recorded `MediaStream`. The `AudioContext` /
  `createMediaElementSource` machinery, the private `Audio` element, and all
  `onMessagePlayed` calls were removed. Track re-binding runs on a short
  interval while recording because `Avatar` assigns `audioElementRef` inside
  its own effect.
- **Why minimal**: `Avatar` remains the sole owner of `play()`,
  `onended` → `onMessagePlayed`, and lipsync timing; recorder no longer
  touches playback at all.
- **Runtime behavior**: recordings still produced (canvas + captured audio).
  On browsers without `captureStream` (Safari) it records video-only and logs
  a warning — playback is never degraded. Recording now also triggers on
  `audioUrl`-based lecture messages, not just base64 `message.audio`.

### Fix 3 — React hooks ordering in `Scene.jsx`

- **Root cause**: `export default function Scene()` had an early
  `return <NotFound />` before `useMemo`/`useState`/`useEffect` calls —
  structurally violating the Rules of Hooks.
- **Fix**: `Scene` is now a thin wrapper that calls `useParams`, looks up
  `SCENE_CONFIG[sceneName]`, returns `<NotFound>` when absent, and otherwise
  renders `<SceneRoom sceneName baseConfig />` — a new child component
  containing all the previous hooks and logic verbatim.
- **Why minimal**: no hook was reordered or re-typed; the invalid-scene path
  simply never mounts `SceneRoom`.
- **Runtime behavior**: identical for valid and invalid scenes.

### Fix 4 — Stale launcher paths

- **Root cause**: after the repo restructure, code moved to `src/backend`
  and `src/frontend`, but launchers still referenced root-level `backend/` /
  `frontend/`.
- **Fix**:
  - `run_app.sh`: `.env` check, dependency-install loop, and both
    `npm --prefix` launches now use `src/backend` and `src/frontend`.
  - `cosyvoice_tts.sh`: `cd backend`/`cd frontend` → `cd src/backend`/
    `cd src/frontend`; log redirections updated `../logs` → `../../logs`
    (cwd is now one level deeper); `cd ..` → `cd ../..`. CosyVoice block
    untouched (its depth didn't change).
  - `docker-compose.yml`: build contexts and bind mounts updated to
    `./src/frontend` and `./src/backend`; stale `VITE_API_URL=http://
    localhost:5000` corrected to `http://localhost:3000`.
- **Runtime behavior**: scripts now actually launch the current code.

### Fix 5 — Hardcoded backend URL

- **Fix**: new `src/frontend/src/config.js`:
  ```js
  export const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';
  ```
  Updated every active call site: `Scene.jsx` (lecture segments fetch,
  `audioUrl` prefix, `io(API_URL)`), `useSpeech.jsx` (`backendUrl`),
  `Scenario.jsx` (`SLIDE_API_BASE`), `SettingsPanel.jsx` (×3),
  `services/lectureApi.js` (×2), `LecturePicker.jsx` (×2).
- **Intentionally untouched**: `vite.config.js` proxy targets (dev-proxy
  config, not app code); `SpeechSystem.jsx` (`:5000` CosyVoice, unused page);
  backend self-fetch `http://localhost:${port}` in `server.js`.
- **Docs/config**: `src/frontend/.env.example` added; `.env` added to
  `src/frontend/.gitignore`. No secrets committed.
- **Runtime behavior**: local dev works with zero env setup; any deployment
  can override via `VITE_API_URL`.

### Fix 6 — Dead / commented legacy code (touched files only)

- `server.js`: two fully commented legacy server versions (~445 lines),
  commented `/transcribe` block, commented whisper import.
- `useSpeech.jsx`: ~145-line commented legacy provider + dead
  `sendAudioData` (its only reason to exist was `/sts`).
- `ContinuousRecorder.jsx`: ~720 lines of commented iterations.
- `SettingsPanel.jsx`: ~138-line commented legacy panel + commented
  `handleSubmit`.
- Verified each range contained only comments/blank lines before deletion.
- Not touched: `whisper.mjs`, `SpeechSystem.jsx`, `RemoteUser.jsx`,
  `AvatarFileSelector.jsx`, `skeleton.js`, `VoxCPM/`, etc.

---

## 3. Validation performed

| Check | Command | Result |
|---|---|---|
| Frontend build | `npx vite build` (in `src/frontend`) | ✓ built in ~3s, no errors |
| Backend boot | `PORT=3100 node server.js` | ✓ listening, no import errors |
| Settings endpoint | `curl :3100/settings` | `200` |
| `/sts` now controlled | `curl -X POST :3100/sts` | `404` (no crash) |
| Script syntax | `bash -n run_app.sh`, `bash -n cosyvoice_tts.sh` | OK |
| Hardcoded URLs | `grep localhost:3000 src/frontend/src` | only `config.js` remains |
| `/sts` refs | `grep` for `sts`/`sendAudioData`/`convertAudioToText` in active code | none |

`EADDRINUSE` appeared on the first backend test only because a backend was
already running on `:3000`; the check was re-run on `:3100`. No lint script
exists in `package.json`, so none was run.

---

## 4. `/sts` decision

**`REMOVED AS UNUSED LEGACY`**

Evidence:

- `modules/whisper.mjs` is 100% commented — `convertAudioToText` is not
  defined anywhere.
- The only caller, `sendAudioData` in `useSpeech.jsx`, was never invoked or
  exported through the context — dead code.
- Repair would require re-adding the OpenAI Whisper cloud dependency, which
  the task prohibits ("do not introduce a new cloud dependency").

---

## 5. Recorder verification

Professor audio can no longer play twice because `ContinuousRecorder`
contains **no `new Audio` and no `play()` call at all**. The single audio
element per message is created inside `Avatar.jsx` and stored in
`audioElementRef`; the recorder only calls `element.captureStream()` on it —
a read-only tap that does not affect `play()`, `pause()`, `currentTime`, or
the message queue (`onMessagePlayed` is exclusively `Avatar`'s `onended`
again). Stopping the recorder stops tracks on the recording `MediaStream`
only; ending a captured track never pauses the source element.

---

## 6. Remaining issues (discovered, intentionally not fixed)

- `grant-floor` is unauthenticated — any client can grant the floor.
- `POST /settings` writes `.env` relative to CWD — correct only when launched
  from `src/backend`.
- `SOCIAL_INTERACTION_CURRENT_STATUS.md` is outdated — the floor queue *is*
  implemented now.
- `POST /tts` still runs the legacy OpenAI + ElevenLabs path (out of scope).
- `modules/whisper.mjs` remains as a fully commented file (untouched — not a
  file modified by this task's fixes).
- Unused files retained per instructions: `SpeechSystem.jsx`,
  `LecturePicker.jsx` (updated only for `API_URL` consistency),
  `RemoteUser.jsx`, `AvatarFileSelector.jsx`, `skeleton.js`, `VoxCPM/`,
  `voxcpm-env/`.
- `SpeechSystem.jsx` hardcodes `http://localhost:5000` (CosyVoice service,
  unrouted page).

---

## 7. Final diff summary

```
 cosyvoice_tts.sh                                   |  12 +-
 docker-compose.yml                                 |  10 +-
 run_app.sh                                         |  10 +-
 src/backend/server.js                              | 510 ---
 src/frontend/.gitignore                            |   1 +
 src/frontend/src/Scene.jsx                         | 379 ++--
 src/frontend/src/components/ContinuousRecorder.jsx | 834 +-----
 src/frontend/src/components/LecturePicker.jsx      |   5 +-
 src/frontend/src/components/Scenario.jsx           |   3 +-
 src/frontend/src/components/SettingsPanel.jsx      | 174 +--
 src/frontend/src/hooks/useSpeech.jsx               | 172 +--
 src/frontend/src/services/lectureApi.js            |   6 +-
 12 files changed, 322 insertions(+), 1794 deletions(-)
```

New files: `src/frontend/src/config.js`, `src/frontend/.env.example`.

Note: the `Scene.jsx` diff also contains the previously uncommitted
top-center toolbar redesign and `AvatarPicker` close button from the earlier
session — every *new* change in this patch maps to one of the six requested
fixes.

---

## Definition of Done — status

- [x] Six requested areas addressed
- [x] Frontend builds successfully
- [x] Backend has no new startup/import errors
- [x] Professor audio is not duplicated
- [x] React hook ordering is valid
- [x] Launcher paths match `src/backend` / `src/frontend`
- [x] Backend origin configurable via `VITE_API_URL`
- [x] Dead commented code removed in touched files only
- [x] Unrelated features untouched
- [x] Diff is narrow and auditable
