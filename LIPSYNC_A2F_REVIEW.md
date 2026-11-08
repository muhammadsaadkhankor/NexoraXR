# Audio2Face-3D Lip-Sync Migration — Feasibility Review

Investigation only. Goal: replace `realtimeLipSync.js` (spectral viseme
classification) with NVIDIA Audio2Face-3D blendshape tracks precomputed
offline for the baked WAV corpus, applied to the Avaturn ARKit-52 rigs.

---

## 1. SDK + models

**Audio2Face-3D-SDK** (`github.com/NVIDIA/Audio2Face-3D-SDK`, MIT license)

- C++/CUDA SDK: Audio2Face (regression + diffusion) + Audio2Emotion.
- Requirements: **CUDA >=12.8 <13.0 (12.9 recommended)**, **TensorRT
  >=10.13 <11.0**, Linux (Ubuntu 20.04+) or Windows, CMake, python 3.8–3.10
  (build/test helpers only — the runtime API is C++).
- GPU archs covered: 75–120 (our Ada GPU = sm_89 ✓).
- Build: `fetch_deps.sh` → `build.sh all release` → `_build/release/…` with
  `libaudio2x.so`, headers, and `sample-a2f-executor` binaries. Models ship
  as ONNX + model_data bundles converted to TensorRT engines at first use.
- Executors: **multi-track (batch)** — accumulate audio, callback per frame,
  built for offline throughput; **interactive** — whole-audio parameter
  editing. Multi-track is the right one for baking.
- Output: skin/tongue geometry + jaw transform + eye rotations; an
  `IBlendshapeSolver` post-process converts geometry → **blendshape weights**.
  NVIDIA adopted the **Apple ARKit standard** for weights, and their bundled
  rigs (Mark/Claire/James) are ARKit-named — the Maya-ACE compat guide says
  blendshape output drives "any ARKit asset". Our Avaturn ARKit-52 set maps
  1:1 by name; no custom rig needed for lipsync (eyes/jaw rotation outputs
  are optional extras we can ignore or map to eyeLook*/jawOpen).

**Models** (HF collection `nvidia/audio2face-3d`, NVIDIA Open Model License —
commercial use OK):

| Model | Arch | Params | Notes |
|---|---|---|---|
| **v2.3-Mark** (regression) | Transformer/Wav2Vec2 | ~18.6M | production-proven, deterministic, 60fps output, smallest footprint |
| v2.3.1-Claire | regression | ~39.8M | female voice model |
| v2.3.1-James | regression | — | second male identity |
| **v3.0** (diffusion) | Transformer/HuBERT | ~180M | higher fidelity, multi-identity (identity_index selects Mark/Claire/James), slower |
| Audio2Emotion v2.2/v3.0 | classifier | — | optional emotion stream feeding A2F |

Recommendation: start with **v2.3-Mark regression** — deterministic, fast,
60fps ARKit weight output, exactly what offline baking needs. Evaluate v3.0
diffusion later if expressiveness matters.

## 2. WAV → ARKit weights: available paths

There is **no official Python binding** — three realistic paths:

| Path | Effort | How |
|---|---|---|
| **a) NIM + Python gRPC client** | Lowest code, needs Docker + NGC pull | `Audio2Face-3D-Samples/scripts/audio2face_3d_microservices_interaction_app/a2f_3d.py run_inference audio.wav config.yml -u 127.0.0.1:52000` → writes per-frame animation data to files. NIM = NVIDIA Software License (container from NGC). |
| **b) Build SDK + C++ sample** | Medium — but see §3 caveat | `sample-a2f-executor` shows bundle + executor + WAV loading; extend to dump frames (the sample prints/saves; thin wrapper to JSON is small). SDK is MIT. |
| **c) Third-party wrapper** | Docker build of the SDK inside container | `mysticfall/audio2face-api-server` — `POST /blendshapes` with float32 mono 16kHz PCM → `{fps:60, blendshape_names:[ARKit names…], frames:[[w…]]}` directly usable. Proves SDK emits ARKit-named weights without our own C++. |

Practical suggestion: **path (c)** — or (a) if NGC access is easy — because
path (b) collides with our CUDA version (next section). Input must be
mono 16kHz PCM (our WAVs are 48kHz → resample with ffmpeg first, one line
per file).

## 3. GPU/host compatibility — RTX 4000 Ada (20 GB)

- **VRAM**: fine. GPU is at ~9.9/20.5 GB used (stream-tts ~7.3 + whisper/ollama
  ~2.6). Regression model ≈ 18.6M params → TRT engine + workspace ~1 GB;
  v3.0 ~2–3 GB. Worst case ~13 GB used of 20.5 — comfortable.
- **Speed**: NVIDIA advertises ">60 fps frame generation", and batch mode
  multi-track parallelism multiplies that. Expect ≥10–30× realtime for
  regression → the full ~11-hour corpus ≈ 20–60 min; my_L1 (~37 min)
  ≈ 1–3 min.
- **⚠️ System CUDA = 13.1** (`cuda-toolkit-13-1` installed) — **outside the
  SDK's <13.0 window**. TensorRT is also not installed system-wide. Native
  build needs a CUDA 12.9 side-install (or conda toolkit) + TensorRT 10.13
  tarball + `CUDA_PATH`/`TENSORRT_ROOT_DIR`. **This is the strongest argument
  for the Docker paths** — the NIM/wrapper images carry the correct
  CUDA+TRT internally.
- Driver supports sm_89 ✓.

## 4. Frontend changes (`Avatar.jsx` / `realtimeLipSync.js`)

Current flow:

- `realtimeLipSync.js` — taps the `<audio>` element via `attachAnalyser()`
  (Web Audio AnalyserNode, fftSize 1024), and `analyseViseme()` classifies
  each frame's spectrum into ONE `viseme_*` name + level (lines 101–138).
  `attachStreamAnalyser()` does the same for remote mic streams (students).
- `Avatar.jsx useFrame` (lines 311–363) — `lerpMorphTarget(name, value, speed)`
  traverses `group.current` and sets `morphTargetInfluences[idx]` on **every
  skinned mesh whose `morphTargetDictionary` contains the name** (lines
  84–94). So a name applied once already reaches Head + Teeth + Tongue +
  Eye + EyeAO + Eyelash — exactly the multi-mesh behavior we need.
  Fallback path: legacy `lipsync.mouthCues` → `visemesMapping` (Rhubarb).

What changes for precomputed tracks:

1. **New track format** — per WAV, e.g.
   `segment_000_a2f.json` / `utt_<hash>_a2f.bin`:
   `{fps: 60, names: [52 ARKit names], frames: Float32Array}`.
   Size: 52 weights × 60fps × 4B ≈ **12.5 KB/s**. 60-min language bucket
   ≈ 45 MB binary (or ~1.5 MB/min as JSON — prefer binary/Float32 or
   gzipped JSON; 30fps halves it). Corpus ~673 min ⇒ ~0.5 GB binary.
2. **Playback** — message payload gains `a2fUrl` (or piggyback on
   `lipsyncUrl`); `Avatar.jsx` fetches the track once per message, and in
   `useFrame` does `frame = track[floor(audio.currentTime * fps)]` then
   `lerpMorphTarget(name, weight, ~0.35)` for each of the 52 names. The
   existing name-based traversal already fans out to all 6 meshes —
   **the apply-by-name code needs no changes**, only the data source.
3. **Keep the analyser** for live inputs it can't precompute: remote-mic
   students (`attachStreamAnalyser`) and any uncached TTS. A2F track is the
   preferred source when present; analyser/mouthCues remain fallbacks.
4. **Eye blinks** — A2F does not drive `eyeBlink*`; keep the existing random
   blink timer. Optionally feed `eyeSquint*`/`brow*` from the A2F weights
   (free extra expressiveness).
5. **Sync resilience** — index by `audio.currentTime` (already used by the
   mouthCues path and the 400ms drift-corrector), so seeks/pauses stay aligned.

## 5. Bake workload — current WAV corpus

| Bucket | Files | Duration |
|---|---|---|
| `segments/my_L1*` (6 langs) | 60 | **37.1 min** |
| `segments/*` other lectures (112 dirs) | 943 | 504.7 min |
| `answers/` (utterances+answers, all lectures) | 911 | 131.8 min |
| **Total** | **1,914** | **~673 min (~11.2 h)** |

my_L1 alone (segments + its ~12 utterances) ≈ **39 min** — a few minutes of
inference even single-tracked. Full corpus is worth multi-track batching.

Per-language my_L1 segment audio: en 7.2 min, ar 5.6, zh 6.5, es 7.0,
fr 5.5, de 5.3.

## Open questions / risks

- **CUDA 13.1 vs SDK <13.0** — native build blocked until CUDA 12.9 lands
  side-by-side; Docker paths sidestep this entirely.
- NIM needs NGC registry access (docker login + image pull); license is
  NVIDIA SLA (not MIT) — check acceptance.
- ARKit name match: our GLBs carry all 52 names verbatim, so weight→morph
  mapping is direct; solver output names should be verified once against
  `Head_Mesh` (v2/v3 rigs both emit ARKit v2 names, a superset-compatible
  scheme — confirm `jawForward`/`tongueOut` presence in emitted set).
- A2F's tongue/jaw/eye outputs are separate transforms — we only take the
  blendshape-weight stream; Avaturn tongue/teeth already deform via shared
  mouth ARKit targets.
- Regression model is English-speech-trained (Mark/Claire are English
  speakers); multilingual lipsync quality on ar/zh should be spot-checked —
  phoneme coverage is decent but worth an A/B against the spectral path.
