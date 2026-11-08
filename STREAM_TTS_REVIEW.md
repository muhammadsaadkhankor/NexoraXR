# stream-tts Review — `./stream-tts/` (cloned 2026-11-07)

Companion to `TTS_CURRENT_SETUP.md`. Investigation only — nothing was changed.

**TL;DR:** `./stream-tts` is a small, clean FastAPI wrapper around `nano-vllm-voxcpm` serving VoxCPM2 as **streaming raw s16le PCM @48 kHz** on **`:8000`**. The same code is **already running** on this machine (from the sibling clone `~/MuhammadSaad_Workspace/voxcpm`, not this copy) — `GET /ready` → `{"ready":true,"sample_rate":48000}`. It loads weights from the **same HF cache** the old vLLM used. `openai-whisper` installs cleanly into the `tts` env per dry-run (no torch/flash-attn changes). The old `:8010` vLLM-Omni is **down**. `stream-tts/` is a nested independent git repo — parent sees it as untracked `?? stream-tts/`; recommended: **git submodule** (or gitignore it).

---

## 1. Folder structure

```
stream-tts/                       (584 KB, own .git — single commit 6a5652a)
├── server/voxcpm_server.py       FastAPI engine, :8000 — THE part NexoraXR needs (96 lines)
├── studio/
│   ├── backend/server.py         Voice Studio proxy + voice library + history, :3100
│   │                             (uses `httpx2`, `soundfile`, ffmpeg; docstring wrongly says "port 8001")
│   ├── backend/requirements.txt  fastapi, uvicorn[standard], httpx2, python-multipart, soundfile
│   ├── frontend/                 React + Vite + TS + Tailwind, dev :8080 (proxies /api → :3100)
│   ├── voices/<id>/              runtime voice store: meta.json, converted.wav (16 kHz mono), latents.b64
│   ├── history/                  last 20 generations (wav + json meta, auto-pruned)
│   └── README.md
├── scripts/start_server.sh       conda activate tts → .env → uvicorn :8000
├── scripts/start_studio.sh       conda tts → engine /ready check → backend :3100 + npm dev :8080
├── tests/test_clone.py           smoke test: encode ref once → zh/fr/ar × {refonly, prompt} modes, prints TTFA/RTF
├── setup.md                      env install — ORDER MATTERS (see §3)
├── requirements.txt              pinned non-torch deps of env `tts` (see below)
├── .env.example                  engine env vars (see §2)
├── .gitignore                    *.wav/*.mp3/etc, studio/voices|history contents, model caches, .env, node_modules
└── README.md                     full API docs + Python/Node client examples
```

`requirements.txt` notes: pins `huggingface_hub==2.4.0`, `transformers==5.22.2`, `tokenizers==0.23.3`, `librosa==0.11.0`, `numba==0.68.1`, `soundfile==0.14.0`, `fastapi==0.162.2`, `uvicorn==0.54.0`, and **`httpx2==2.16.0`** (an httpx fork — the studio backend imports `httpx2`). Torch-family packages are deliberately excluded (installed separately per setup.md).

## 2. Engine API — `server/voxcpm_server.py` (:8000)

| | |
|---|---|
| `GET /ready` | → `{ready: bool, sample_rate: int \| null}` |
| `POST /encode_latents` | `{wav_base64, wav_format="wav"}` → `{prompt_latents_base64, sample_rate}` — encode a reference clip once, reuse forever |
| `POST /generate` | streams **raw s16le PCM, mono, 48 kHz** |

`/generate` request fields:

| Field | Type | Default | Notes |
|---|---|---|---|
| `target_text` | str | required | text to synthesize (language auto-detected) |
| `ref_audio_latents_base64` | str? | null | cross-language voice cloning |
| `prompt_latents_base64` | str? | null | best-similarity mode — **requires `prompt_text`** (400 if missing) |
| `prompt_text` | str | `""` | transcript of the prompt clip |
| `cfg_value` | float | 2.0 | guidance (1.0–3.0) |
| `temperature` | float | 1.0 | sampling (0.5–1.5) |
| `seed` | int? | null | reproducibility |
| `max_generate_length` | int | 2000 | token cap |
| `response_format` | str | `"pcm"` | **accepted but ignored — always raw PCM** |

Response: `StreamingResponse` of int16 PCM (`np.clip(wav,-1,1)*32767` → `<i2`), `media_type: audio/L16;rate={sr};channels=1`, headers `X-Audio-Sample-Rate` / `X-Audio-Channels` / `X-Audio-Encoding: s16le`. One call = one text (no internal sentence splitting — the Studio adds that, plus 0.15 s silence gaps).

**Engine env vars** (`os.getenv` at module top; `.env` auto-loaded by start script):
`VOXCPM_MODEL`=`openbmb/VoxCPM2` · `VOXCPM_GPU_UTIL`=`0.8` · `VOXCPM_MAX_SEQS`=`8` · `VOXCPM_TIMESTEPS`=`10` · `VOXCPM_HOST`=`0.0.0.0` · `VOXCPM_PORT`=`8000`. Hardcoded: `devices=[0]`, `max_num_batched_tokens=8192`; `max_model_len` uses the lib default 4096.

**Cloning modes:** `ref_audio_latents_base64` alone → cross-language clone; `prompt_latents_base64` + `prompt_text` → best-similarity (transcript required — maps directly to our `voxcpm_data` `prompt_text` fields).

## 3. Startup & runtime status

- `scripts/start_server.sh`: finds conda → `conda activate tts` → sources `.env` → `exec python -m uvicorn server.voxcpm_server:app --host ${VOXCPM_HOST:-0.0.0.0} --port ${VOXCPM_PORT:-8000}`.
- `scripts/start_studio.sh`: same env, warns if engine not ready, `npm install` if needed, uvicorn backend `:3100` + `npm run dev` `:8080`.
- `setup.md` install order (the only order that worked): `conda create -n tts python=3.11` → `pip install torch==2.8.0 torchaudio==2.8.0 --index-url .../whl/cu128` → ninja/packaging/psutil → `flash-attn==2.8.3 --no-build-isolation` → `nano-vllm-voxcpm "torchcodec==0.6.*" -r requirements.txt`.
- **Live status (checked now):** `GET http://localhost:8000/ready` → `{"ready":true,"sample_rate":48000}` — **engine IS running**, but the process (pid 2005429, `~/anaconda3/envs/tts/bin/python3.11`) was started from the **sibling clone `~/MuhammadSaad_Workspace/voxcpm`**, not `NexoraXR/stream-tts`. Both checkouts are at the same commit (`6a5652a`), so the running engine is identical code — just be aware two clones now exist.
- Studio backend `:3100` / frontend `:8080`: **not running**. NexoraXR backend `:3000`: not running. Old vLLM `:8010`: **not running** (its `logs/voxcpm.log` shows clean shutdown today 11:24).
- `tts` env: Python 3.11.0 — `nano-vllm-voxcpm 2.0.5`, `flash_attn 2.8.3`, `torch 2.8.0+cu128`, `torchaudio 2.8.0+cu128`, `torchcodec 0.6.0`, `triton 3.4.0`, `numba 0.68.1`, `ffmpeg` at `/usr/bin/ffmpeg`.

## 4. Model weights / HF cache

`nanovllm_voxcpm/llm.py` `VoxCPM.from_pretrained` → `snapshot_download(repo_id="openbmb/VoxCPM2")` (huggingface_hub) → resolves to the standard cache:

```
~/.cache/huggingface/hub/models--openbmb--VoxCPM2/snapshots/32279effe8c19989596f05d353d1447f51d9e915
```

— **the SAME 4.7 GB cache the old vLLM-Omni `:8010` used.** `VOXCPM_MODEL` also accepts a local directory path (or `~`-expanded path) instead of a repo id. No re-download needed; the old cache can also be deleted once migration is verified since nothing else uses it.

## 5. Git status — nested repo

- `./stream-tts` has its own `.git` (remote `github.com/muhammadsaadkhankor/stream-tts`, one commit `6a5652a`, clean tree). It is **not** a submodule — no `.gitmodules`; it was `git clone`d.
- NexoraXR `git status` shows `?? stream-tts/` as a single untracked entry; `git check-ignore` → not ignored.
- **If you `git add stream-tts`**, git will warn "adding embedded git repository" and commit a **gitlink** (mode-160000 commit pointer) *without* `.gitmodules` — a broken pseudo-submodule that clones as an empty dir on other machines.
- **Recommendation:** make it a real submodule —
  `git rm --cached -r stream-tts 2>/dev/null; rm -rf stream-tts && git submodule add https://github.com/muhammadsaadkhankor/stream-tts.git stream-tts`
  — version-pinned, pulls on `git submodule update --init`.
  Simpler alternative if you treat it as a local deployment artifact (like conda envs): add `/stream-tts/` to NexoraXR `.gitignore` and document the clone step. Avoid plain `git add` either way. (The repo README itself suggests cloning as `tts_component` — the dir name is your choice; `stream-tts` works fine.)

## 6. Whisper compatibility check (dry-run only)

```
$ ~/anaconda3/envs/tts/bin/pip install --dry-run openai-whisper
…
Would install more-itertools-11.2.1 openai-whisper-20250625 tiktoken-0.14.0
```

**Clean install — no conflicts.** Only 3 new packages; every heavy dep is already satisfied (`torch` stays 2.8.0, `torchaudio` 2.8.0, `flash_attn` 2.8.3, `triton` 3.4.0, `numba` 0.68.1, `tqdm` 4.70.1). `ffmpeg` present at `/usr/bin/ffmpeg` (needed by `whisper.load_audio`). So `langDetect.mjs`'s `WHISPER_PYTHON` can simply be repointed to `~/anaconda3/envs/tts/bin/python` and the `voxcpm` env retired entirely.

## 7. GPU state

```
nvidia-smi: 16,662 / 20,475 MiB used, 17% util
compute-apps: pid 2005486  ~/anaconda3/envs/tts/bin/python3.11  → 15,418 MiB
```

- The **stream-tts engine on :8000 holds ~15.4 GiB** (default `VOXCPM_GPU_UTIL=0.8` ≈ 16.4 GiB budget of the 20.5 GiB card). ~3.9 GiB free.
- **Old vLLM-Omni `:8010`: not running** — nothing else on the GPU besides the stream-tts engine.
- ⚠️ For NexoraXR: 0.8 is too greedy to coexist with Ollama + Whisper like the old 0.35 setting. Set `VOXCPM_GPU_UTIL≈0.35–0.4` in `stream-tts/.env` before integrating (nano-vllm may need more headroom than vLLM for the same model — measure, don't assume 0.35 works).

## 8. Notes for the NexoraXR migration (context)

- Voice store differs: studio keeps `voices/<id>/{meta.json, converted.wav (16 kHz mono, silence-trimmed, 3–30 s), latents.b64}` — our `voxcpm_data/voices/*/prompt.wav` clips + `prompt_text` transcripts map 1:1 onto `/encode_latents` + `prompt_text` (or a small Node-side equivalent of the studio's encode-once-then-cache flow).
- Engine `/generate` does **no** sentence splitting — the Studio does it proxy-side; NexoraXR would need its own splitting (it already has `splitSummaryText`/sentence-split rescue logic) or reuse the studio backend's pattern.
- Response is raw PCM → wrap in `pcm16ToWav(48000)` (`audioUtils.mjs` — note it defaults to 24000 today) or stream it through.
- Minor bugs to be aware of (upstream, not blocking): studio `server.py` docstring says "port 8001" (actually :3100); `GenReq.response_format` accepted but ignored.
