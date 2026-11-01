# WuFlux (NexoraXR) — Installation Guide

## 1. Introduction

**WuFlux (NexoraXR)** is an AI-powered virtual classroom platform. An instructor uploads lecture PDFs, the system automatically generates lecture scripts, translates them into six languages (English, Arabic, French, German, Spanish, Chinese), synthesizes professor narration with a cloned voice, and hosts a 3D multiplayer classroom where an AI professor avatar teaches the material synced to the original slides.

### Key Features

- **PDF → Classroom pipeline**: upload PDFs → English script generation (Ollama LLM) → one-click approval → automatic translation to AR/FR/DE/ES/ZH → TTS audio for all six languages.
- **Slide–script alignment**: every narration segment carries document/page provenance; slides, subtitles and audio share the same segment index, so mid-lecture language switching stays in sync.
- **3D multiplayer classroom** (React Three Fiber + Socket.IO): professor avatar with viseme lip-sync, student avatars, lecture clock, public/private rooms with invite links.
- **Resumable generation**: failed/partial audio can be retried per segment without regenerating completed work; builds survive server restarts.
- **Passwordless auth**: magic-link sign-in (console-delivered in dev, Resend in prod), guest access, admin/instructor roles.
- **Eval records**: per-lecture generation metrics (model, tokens, validation) in `eval/records/`.

### Non-Functional Requirements

| Requirement | Spec |
|---|---|
| OS | Linux (developed/tested on Ubuntu; CUDA-capable host for TTS) |
| Runtime | Node.js ≥ 20, npm |
| GPU | NVIDIA GPU recommended for VoxCPM TTS + Whisper language check (CPU works but is very slow); ~20 GB VRAM observed for `gpu-memory-utilization 0.35` alongside other models |
| Services | Ollama (:11434), VoxCPM/vLLM (:8010), PostgreSQL (:5433 local default or any `DATABASE_URL`) |
| Ports | Frontend 5173, Backend 3000 |
| Browsers | Modern Chrome/Firefox with WebGL |

---

## 2. Clone & Install

```bash
git clone https://github.com/muhammadsaadkhankor/NexoraXR.git
cd NexoraXR
npm install        # root postinstall installs server, AI and client packages
```

`npm install` at the root automatically runs `install:all` (installs `src/nexora_server`, `src/nexora_ai`, `src/nexora_client`) and `db:setup --soft`.

---

## 3. Restore the Asset Files (not in Git)

Binary assets (~60 MB: scenes, avatars, animations) are **gitignored and not pushed to GitHub** — they are hosted on Box and must be downloaded after cloning. The app loads them from `src/assets/` via symlinks in `src/nexora_client/public/`.

### Download & extract

The asset bundle is hosted at:
**https://app.box.com/s/av7xttv46pgs99rafv0ttisj3f1p97tu**

The archive is **`WuFlux_assets.zip`** — inside it, `assets/` sits under a `WuFlux_assets/` wrapper folder (`WuFlux_assets/assets/…`). Only the inner `assets/` folder is needed, so extract and move it directly into `src/`:

**Option A — browser:** open the link, click **Download**, then:

```bash
# from the repo root
unzip ~/Downloads/WuFlux_assets.zip -d /tmp/wuflux
mv /tmp/wuflux/WuFlux_assets/assets src/assets
rm -rf /tmp/wuflux                      # wrapper + zip leftovers
```

**Option B — CLI (direct link):**

```bash
curl -L "https://app.box.com/shared/static/av7xttv46pgs99rafv0ttisj3f1p97tu" \
  -o /tmp/WuFlux_assets.zip
unzip /tmp/WuFlux_assets.zip -d /tmp/wuflux
mv /tmp/wuflux/WuFlux_assets/assets src/assets
rm -rf /tmp/wuflux
```

> Result: `src/assets/` contains `scene/`, `avatar/`, `useravatar/`, `animations/`, `animations-fbx/`, `models/`, etc. The `WuFlux_assets/` wrapper folder is discarded.

### Expected contents

```
src/assets/
├── scene/          # scene.glb, modified-classroom.glb (classroom)
├── avatar/         # ProfAbed_*.glb (professor avatar)
├── useravatar/     # UserAvatar.glb + avatars/anim_*.glb (students)
├── animations/     # user locomotion .glb set
├── animations-fbx/ # FBX talking/idle clips
├── models/         # animations.glb (professor extra clips)
├── animatio.glb
├── heroposter.png
└── images/
```

### Create the symlinks — automatic

**Nothing to do here.** `npm install` runs `scripts/link-assets.mjs` (postinstall), which creates all four `public/` symlinks for you:

```
public/assets      -> ../../assets
public/models      -> ../../assets/models
public/animations  -> ../../assets/animations-fbx
public/animatio.glb-> ../../assets/animatio.glb
```

It's idempotent and order-independent — symlinks don't need the target to exist, so `npm install` can run before or after extracting the zip. To re-run manually: `node scripts/link-assets.mjs`.

### Fresh-clone quickstart (the whole asset step)

```bash
git clone <repo> && cd NexoraXR
npm install                                    # packages + symlinks + db check
curl -L "https://app.box.com/shared/static/av7xttv46pgs99rafv0ttisj3f1p97tu" -o /tmp/WuFlux_assets.zip
unzip /tmp/WuFlux_assets.zip -d /tmp/wuflux && mv /tmp/wuflux/WuFlux_assets/assets src/assets
# …set up .env, Ollama, TTS, Postgres…
npm run dev
```

### Other files intentionally not in Git

| Path | What |
|---|---|
| `src/nexora_server/.env` | secrets & local config — create it yourself (below) |
| `profbrain/` | generated lecture scripts/slides output |
| `src/nexora_ai/lecture_cache/` | TTS audio cache |
| `logs/`, `uploads/`, `.run_pids` | runtime artifacts |
| `eval/records/*.json` may be local | generator eval metrics |

---

## 4. Environment Variables

Create `src/nexora_server/.env`:

```dotenv
PORT=3000
DATABASE_URL=postgres://postgres:postgres@localhost:5433/nexoraxr

# LLM (Ollama)
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=qwen2.5:7b        # used by RAG/chat paths
COURSE_LLM_MODEL=qwen3:8b      # course script generator + translations

# TTS (VoxCPM via vLLM-Omni)
VOXCPM_BASE_URL=http://localhost:8010
VOXCPM_VOICE_ID=<professor voice id>
VOXCPM_MODEL=openbmb/VoxCPM2

# Dev auth — magic links printed to the backend terminal
AUTH_DELIVERY_MODE=console
PUBLIC_BASE_URL=http://localhost:5173
NXR_ADMIN_CLAIM_TOKEN=<any random string>
```

For production email delivery use `AUTH_DELIVERY_MODE=resend` plus `RESEND_API_KEY` and `EMAIL_FROM`.

---

## 5. Set Up Ollama (LLM)

```bash
# Install Ollama (Linux)
curl -fsSL https://ollama.com/install.sh | sh

# Pull the models used by the course pipeline
ollama pull qwen3:8b            # script generation + translations
ollama pull qwen2.5:7b          # RAG / chat
ollama pull nomic-embed-text    # embeddings

# Verify it's serving
curl http://localhost:11434/api/tags
```

---

## 6. Set Up the TTS Service (VoxCPM / vLLM-Omni)

The project uses **VoxCPM2 served through vLLM-Omni** (OpenAI-compatible `/v1/audio/speech`) in a dedicated conda env:

```bash
conda create -n voxcpm python=3.12
conda activate voxcpm
pip install vllm               # vllm-omni build with audio/speech support

# Start the TTS server (GPU)
vllm serve openbmb/VoxCPM2 --omni --host 0.0.0.0 --port 8010 \
  --gpu-memory-utilization 0.35 \
  --allowed-local-media-path /path/to/NexoraXR
```

Whisper (for post-synthesis language verification) is invoked by the backend automatically — ensure a Python env with `faster-whisper`/`whisper` is available on PATH as configured in `src/nexora_ai`.

---

## 7. Database

The backend auto-runs migrations on startup. For the bundled local Postgres on `:5433`:

```bash
npm run db:local      # start local Postgres (first run initializes data dir)
npm run db:status     # verify: "localhost:5433/nexoraxr reachable, 0 pending migration(s)"
```

Or point `DATABASE_URL` at any existing PostgreSQL instance.

---

## 8. Run the App

```bash
npm run dev
```

This starts both:

- **Frontend (Vite)** → http://localhost:5173
- **Backend (Express + Socket.IO)** → http://localhost:3000

Sign in on the landing page — in dev mode (`AUTH_DELIVERY_MODE=console`) the magic-link URL is printed in the **backend terminal**; paste it into the browser to verify.

> `voxcpm_tts.sh` is an alternative one-shot launcher that starts TTS + backend + frontend together (adjusts conda path automatically). `npm run dev` assumes Ollama, VoxCPM and Postgres are already up.

### Verify

- Create Classroom → upload a PDF → scripts generate → **Approve Scripts and Generate Audio (EN, AR, FR, DE, ES, ZH)** → watch `Preparing Multilingual Audio… (lecture N/M · LANG)` → classroom opens when `ready`.
- Per-language artifacts land in `src/nexora_ai/lecture_cache/segments/<lectureId>__<lang>/`.

---

## 9. Troubleshooting

| Symptom | Fix |
|---|---|
| `ERR: Missing API key` at boot | Harmless unless you use the OpenAI fallback path; set `OPENAI_API_KEY` or ignore |
| `ECONNREFUSED :3000` in Vite | Backend not started / still booting |
| `Summary not found for <lecture>` | Lecture artifacts deleted while a build was mid-flight — delete the stale build row or regenerate the course |
| `TTS language mismatch` | VoxCPM voice drift on that segment — retry missing audio; it re-bakes only failed segments |
| `whisper detect failed … CUDA out of memory` | Lower `--gpu-memory-utilization` or free VRAM; retry missing audio later |
| Magic link shows a Cloudflare URL | Stale `PUBLIC_BASE_URL` in `.env` — set `http://localhost:5173` and **restart** the backend (nodemon ignores `.env` changes) |
| Course name already exists | Per-owner duplicate names are rejected case-insensitively — pick a different name or delete the old course |
