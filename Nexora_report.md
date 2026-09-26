# NexoraXR Workspace Technical Report

## 1. Executive Summary

NexoraXR is a digital-twin classroom application that combines a React/Three.js frontend, a Node/Express backend, TTS integration, and AI-driven lecture delivery. The workspace was originally a flat repository with code, models, audio, PDFs, and third-party TTS code all mixed at the top level, making it unsuitable for GitHub and error-prone to run.

This session focused on:

- Restructuring the repository into a single `src/` root.
- Moving all large/binary assets into `src/assets/` and keeping them out of version control.
- Fixing runtime issues: the 404ing lecture slide endpoint and the slide-induced WebGL crash.
- Preventing a common dev-mode "ghost second avatar" multiplayer bug.
- Updating `.gitignore` so that large models, CosyVoice, PDFs, and local runtime data are not pushed.

The local environment now runs with `npm run dev` and the frontend and backend start cleanly on ports 5173 and 3000.

---

## 2. Original State & Problems Found

The initial working tree had:

- `backend/` and `frontend/` at the root.
- `Assets/` with GLB models and images tracked in Git.
- `Client/Landing/` as a separate ignored landing page.
- `CosyVoice/` (5.4 GB of TTS model checkpoints).
- `profbrain/` with raw PDFs, generated summaries, and audio caches.
- `Course_content/` with the Multimedia lecture PDFs.
- `src/frontend/public/assets/` and `public/models/` holding 175 MB of GLB/FBX files.
- `src/backend/bin.zip`, `rhubarb`, `lib/`, `res/`, `extras/` (321 MB of lip-sync/TTS binaries).

These would have made any push to GitHub impossible or extremely slow (GitHub rejects files over 100 MB and recommends repos stay under ~1–2 GB).

Runtime bugs identified:

1. **Lecture slide 404** — the PDF image route was looking in the wrong directory after the backend was moved to `src/backend/`.
2. **WebGL context loss** — a missing slide image caused `useTexture` to throw, bringing down the whole `<Canvas>` and disconnecting the socket.
3. **Ghost second avatar** — the server included the joining socket in the initial `room-state` payload, and stale `remotePlayers` persisted after disconnects, often rendering the local player as a remote avatar.

---

## 3. Repository Restructure

All application code was moved under a single `src/` directory.

| Old location | New location |
|---|---|
| `backend/` | `src/backend/` |
| `frontend/` | `src/frontend/` |
| `Client/Landing/` | `src/client_ui/` |
| `Assets/` | `src/assets/` |
| `profbrain/raw_pdfs/` | `src/assets/courses/Multimedia/` |

Root `package.json` was updated to use `npm --prefix src/frontend` and `npm --prefix src/backend`, so `npm run dev` still starts both servers.

### Final top-level layout

```
NexoraXR/
├── src/
│   ├── assets/
│   │   ├── courses/          # PDFs per course
│   │   │   ├── BIO210/
│   │   │   ├── CS401/
│   │   │   ├── ELG5121/
│   │   │   ├── MED320/
│   │   │   └── Multimedia/
│   │   ├── images/
│   │   └── models/           # GLB avatars, animations, scenes
│   ├── backend/              # Node/Express API
│   ├── client_ui/            # Landing page (currently untracked)
│   └── frontend/             # React/Three.js app
├── profbrain/                # Ignored: local lecture summaries/audio
├── CosyVoice/                # Ignored: 5.4 GB TTS model code
├── package.json              # Root monorepo scripts
├── .gitignore
└── README.md
```

---

## 4. Asset & `.gitignore` Management

All large or runtime-generated files are now ignored so they are not pushed:

- `/CosyVoice/`
- `/profbrain/`
- `/src/assets/`
- `/src/backend/bin.zip`
- `/src/backend/rhubarb`, `lib/`, `res/`, `extras/`, `tests/`, `lecture_cache/`
- `/src/frontend/dist/`
- `/src/frontend/public/assets/`, `public/models/`, `public/animations/`, `public/animatio.glb`
- `/src/client_ui/dist/`
- `/logs/`, `/.run_pids`

Tracked files that were removed from the index (they remain locally):

- `src/backend/bin.zip` (84 MB)
- `src/frontend/cloudflared.deb` (19 MB)
- All GLB/FBX/PNG files in `src/frontend/public/assets/`, `public/models/`, and `public/animations/`

> **Important:** Removing files from the index does not remove them from Git history. The repository still contains these binaries in older commits. To fully shrink the repo, you will need `git filter-repo` or a fresh repository. From this point forward, however, new commits will not push them.

---

## 5. Backend Changes

### `src/backend/lectureRoutes.mjs`

- Fixed the PDF search path after the move to `src/`. It now looks for PDFs under `src/assets/courses/<course>/`.
- Made the endpoint course-aware: it defaults to `Multimedia` and can read `?course=...` for other courses.
- Added a server-side log for missing PDFs.
- Added a course prefix to cached slide PNG names (`Multimedia_Lecture_1_slide.png`) so the same lecture IDs in different courses do not collide.
- Made `nodemon` watch `.mjs` files so route edits reload in dev (`src/backend/package.json`).

### `src/backend/server.js`

- `room-state` now excludes the joining socket's own player from the list sent back to that client.
- `disconnect` still removes the socket from the room.

---

## 6. Frontend Changes

### `src/frontend/src/components/Scenario.jsx`

- Replaced the hard-coded slide URL with `SLIDE_API_BASE`.
- Added `isValidLectureId()` to prevent `undefined` or empty lecture IDs from reaching the URL.
- Added `SlidePlaceholder` with a red panel and `Html` text "Slide unavailable".
- Added a `SlideErrorBoundary` class component around `LectureSlide` so a failed `useTexture` no longer unmounts the entire `<Canvas>`; the scene, avatar, and socket remain connected.

### `src/frontend/src/Scene.jsx`

- Clears `remotePlayers` on socket `disconnect` so stale avatars do not persist across reloads.

---

## 7. Multiplayer: Ghost Avatar Fix

The ghost second avatar was caused by two things:

1. The server sent the joiner's own socket back in the initial `room-state`.
2. The client kept `remotePlayers` after a socket disconnect, and with `myId` reset to `null`, the filter `p.userId !== myId` no longer excluded the stale self.

Fixes applied:

- Server `room-state` payload now filters out the joining socket.
- Client `remotePlayers` state is reset on `disconnect`.

---

## 8. Commits Created

```
6953d4f Consolidate assets into a single src/ folder.
c6fdcfc Move PDFs into scripts/assets/courses/Multimedia and make course-aware.
6528abb Stop tracking profbrain/ and ignore CosyVoice/.
1a872d0 Stop tracking large binary assets and update .gitignore.
81d973c Remove reports and ignore local PDF / lecture asset folders.
ba99790 Fix ghost second avatar when joining a room alone.
9c78985 Make lecture slide loading resilient and improve backend 404 logging.
5ecfc33 Fix backend paths after moving backend into src/.
1e3ff11 Update root gitignore and package scripts for new layout.
6188276 Reorganize repo into src/ and scripts/assets/.
```

The `feature/ai-professor-teaching-engine` branch is 10 commits ahead of `origin/feature/ai-professor-teaching-engine`.

---

## 9. How to Run

From the repository root:

```bash
npm run install:all   # install backend + frontend
npm run dev           # start Vite (5173) + Node backend (3000)
```

The landing page can be started separately with:

```bash
npm run dev:client_ui
```

> Note: `src/client_ui/` is currently untracked. Decide whether to add it or keep it ignored before pushing.

---

## 10. Current Status & Caveats

| Item | Status |
|---|---|
| Code under `src/` | Done |
| Assets under `src/assets/` and ignored | Done |
| Lecture slide 404 fixed | Done, tested for `Lecture_1` |
| Slide error boundary + placeholder | Done |
| Ghost avatar fix | Done |
| `npm run dev` runs both servers | Done |
| `.gitignore` blocks large files | Done |
| `Course_content/` removed | Done (PDFs now in `src/assets/courses/Multimedia/`) |

Remaining caveats:

- `src/client_ui/` is still untracked.
- Old Git history still contains large binaries; the next push will be smaller, but the full repository history is still large.
- A fresh clone will not include `src/assets/` or `CosyVoice/`; these must be restored from a separate storage/backup or re-downloaded.
- The `src/frontend/public/` folder only retains `favicon.ico` and `vite.svg` for serving; the GLB/FBX assets are now in `src/assets/`. If the frontend still needs them at runtime, a build step must copy them from `src/assets/` back into `src/frontend/public/` or Vite's `publicDir` must be reconfigured.

---

## 11. Recommended Next Steps

1. **Confirm `src/client_ui/`**: track the landing page code or add it to `.gitignore`.
2. **Runtime asset path for frontend**: either keep a small build script that copies `src/assets/` into `src/frontend/public/` at dev/build time, or set `publicDir` in `src/frontend/vite.config.js` to the correct assets path.
3. **History cleanup**: after the first successful small push, consider `git filter-repo` or a clean repo to remove binary history.
4. **README update**: document where assets live and how to restore them for new clones.
5. **Environment variables**: keep using `src/backend/.env` (ignored) and `env.template.txt` for safe key management.
