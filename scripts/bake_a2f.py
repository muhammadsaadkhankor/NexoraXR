#!/usr/bin/env python3
"""Bake NVIDIA Audio2Face-3D ARKit-52 blendshape tracks for my_L1.

Runs in the "tts" conda env. For every baked WAV (all 6 languages' segments
plus this lecture's deterministic utterances): resample to 16 kHz mono WAV,
send to the local A2F-3D NIM (gRPC :52000) via the official samples client,
parse animation_frames.csv, and write next to each WAV:

    <name>_a2f.bin   Float32 little-endian, shape (frames x 52), 60 fps
    <name>_a2f.json  {fps, names[52], frames, durationSec, model}

The emitted blendshape names are verified against the Avaturn Head_Mesh
ARKit set — any mismatch is reported, not silently mapped.
"""

import glob
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time

ROOT = "/home/msaad/MuhammadSaad_Workspace/Master-Research/NexoraXR"
SEG_DIR = os.path.join(ROOT, "src/nexora_ai/lecture_cache/segments")
ANS_DIR = os.path.join(ROOT, "src/nexora_ai/lecture_cache/answers")
CLIENT_DIR = "/tmp/a2f-samples/scripts/audio2face_3d_microservices_interaction_app"
CLIENT = os.path.join(CLIENT_DIR, "a2f_3d.py")
CONFIG = os.path.join(CLIENT_DIR, "config", "config_mark.yml")
NIM_URL = "127.0.0.1:52000"
MODEL = "audio2face-3d-v2.3-Mark"
LECTURE = "my_L1"
FPS = 60.0

ARKIT = ["eyeBlinkLeft","eyeLookDownLeft","eyeLookInLeft","eyeLookOutLeft","eyeLookUpLeft","eyeSquintLeft","eyeWideLeft",
 "eyeBlinkRight","eyeLookDownRight","eyeLookInRight","eyeLookOutRight","eyeLookUpRight","eyeSquintRight","eyeWideRight",
 "jawForward","jawLeft","jawRight","jawOpen","mouthClose","mouthFunnel","mouthPucker","mouthLeft","mouthRight",
 "mouthSmileLeft","mouthSmileRight","mouthFrownLeft","mouthFrownRight","mouthDimpleLeft","mouthDimpleRight",
 "mouthStretchLeft","mouthStretchRight","mouthRollLower","mouthRollUpper","mouthShrugLower","mouthShrugUpper",
 "mouthPressLeft","mouthPressRight","mouthLowerDownLeft","mouthLowerDownRight","mouthUpperUpLeft","mouthUpperUpRight",
 "browDownLeft","browDownRight","browInnerUp","browOuterUpLeft","browOuterUpRight","cheekPuff","cheekSquintLeft",
 "cheekSquintRight","noseSneerLeft","noseSneerRight","tongueOut"]
ARKIT_SET = set(ARKIT)

# Exact instruction strings from lectureRoutes.mjs (cache key material).
INSTR = {
    "opening": "Greet the class warmly and say you're starting today's lecture. Do NOT preview, explain, or summarize any topic — the prepared material that follows does that itself. At most 2 short spoken sentences, then hand off naturally.",
    "closing_recap": "Wrap up the lecture: summarize what was covered and name the most important concepts. Do not introduce new material. 3-4 short spoken sentences.",
}


def md5(s: str) -> str:
    return hashlib.md5(s.encode()).hexdigest()


def utterance_keys(lang_dir: str, lang: str):
    """Reproduce utteranceCacheKey for my_L1's two deterministic calls
    (no lecture_plan.json -> opening on seg 0, closing_recap on all segs)."""
    txts = []
    for i in range(10):
        p = os.path.join(SEG_DIR, lang_dir, f"segment_{i:03d}.txt")
        if os.path.exists(p):
            txts.append(open(p, encoding="utf-8").read().strip())
    if not txts:
        return []
    calls = [("opening", [0], txts[0]),
             ("closing_recap", list(range(len(txts))), "\n\n".join(txts))]
    keys = []
    for purpose, seg_ids, material in calls:
        key = md5("::".join([
            LECTURE, lang, purpose, "",
            ",".join(str(i) for i in sorted(seg_ids)),
            INSTR[purpose], md5(material)]))
        keys.append(os.path.join(ANS_DIR, f"utt_{key}.wav"))
    return keys


def collect_jobs():
    """[(wav_path, lang)] — segments for all languages + my_L1 utterances."""
    jobs = []
    per_lang = {}
    for lang in ["", "__ar", "__zh", "__es", "__fr", "__de"]:
        lang_dir = f"{LECTURE}{lang}"
        tag = lang[2:] if lang else "en"
        wavs = sorted(glob.glob(os.path.join(SEG_DIR, lang_dir, "segment_*.wav")))
        # Utterance wavs whose computed keys exist in answers/.
        utts = [p for p in utterance_keys(lang_dir, tag) if os.path.exists(p)]
        per_lang[tag] = (wavs, utts)
        for w in wavs + utts:
            jobs.append((w, tag))
    return jobs, per_lang


def wav_seconds(path: str) -> float:
    import wave
    with wave.open(path) as w:
        return w.getnframes() / w.getframerate()


def to_16k(src: str, dst: str):
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", src,
                    "-ar", "16000", "-ac", "1", "-f", "wav", dst], check=True)


def run_a2f(wav16: str, out_dir_holder: list):
    """Invoke the NIM samples client; return newest output_NNNNNN dir."""
    before = set(glob.glob(os.path.join(CLIENT_DIR, "output_*")))
    r = subprocess.run(
        [sys.executable, CLIENT, "run_inference", wav16, CONFIG,
         "-u", NIM_URL],
        cwd=CLIENT_DIR, capture_output=True, text=True, timeout=600)
    after = set(glob.glob(os.path.join(CLIENT_DIR, "output_*")))
    new = sorted(after - before)
    if r.returncode != 0 or not new:
        raise RuntimeError(f"client failed rc={r.returncode}\n{r.stdout[-500:]}\n{r.stderr[-500:]}")
    out_dir_holder.append(new[-1])
    return os.path.join(new[-1], "animation_frames.csv")


def bake(wav: str, lang: str, tmpdir: str) -> dict:
    base = wav[:-4]  # strip .wav
    wav16 = os.path.join(tmpdir, "in_16k.wav")
    to_16k(wav, wav16)
    holder = []
    csv_path = run_a2f(wav16, holder)

    import pandas as pd
    df = pd.read_csv(csv_path)
    bs_cols = [c for c in df.columns if c.startswith("blendShapes.")]
    # Emitted names are capitalized ("EyeBlinkLeft", "JawOpen"); our GLB uses
    # ARKit camelCase — normalize case, keep only the 52 standard names,
    # and reorder columns to the canonical ARKIT order for a fixed bin layout.
    emitted = [c.split("blendShapes.", 1)[1] for c in bs_cols]
    norm_map = {}            # glb name -> emitted column
    extras = []
    for col, raw in zip(bs_cols, emitted):
        glb_name = raw[0].lower() + raw[1:] if raw else raw
        if glb_name in ARKIT_SET:
            norm_map[glb_name] = col
        else:
            extras.append(raw)
    missing = [n for n in ARKIT if n not in norm_map]
    frames = df[[norm_map[n] for n in ARKIT if n in norm_map]].values.astype("float32")
    names = [n for n in ARKIT if n in norm_map]

    # Emit the actual fps from the timecode stream (service sends ~30fps).
    tc = df["timeCode"].values
    fps = round((len(tc) - 1) / max(tc[-1] - tc[0], 1e-6), 3) if len(tc) > 1 else FPS

    with open(f"{base}_a2f.bin", "wb") as f:
        f.write(frames.tobytes())
    meta = {"fps": fps, "names": names, "frames": int(frames.shape[0]),
            "durationSec": round(wav_seconds(wav), 3), "model": MODEL}
    with open(f"{base}_a2f.json", "w") as f:
        json.dump(meta, f)

    return {"names": names, "frames": int(frames.shape[0]),
            "extra": extras, "missing": missing}


def main():
    import pandas as pd  # noqa: F401  (fail fast if missing)
    jobs, per_lang = collect_jobs()
    print(f"{len(jobs)} wavs to bake")
    stats = {}
    mismatches = []
    with tempfile.TemporaryDirectory() as tmp:
        for wav, lang in jobs:
            t0 = time.time()
            try:
                info = bake(wav, lang, tmp)
                dt = time.time() - t0
                secs = wav_seconds(wav)
                s = stats.setdefault(lang, [0, 0.0, 0.0])
                s[0] += 1; s[1] += secs; s[2] += dt
                tag = os.path.relpath(wav, SEG_DIR)
                extra = f" EXTRA:{info['extra']}" if info["extra"] else ""
                miss = f" MISSING:{info['missing']}" if info["missing"] else ""
                if extra or miss:
                    mismatches.append((tag, info["extra"], info["missing"]))
                print(f"[{lang}] {tag}: {secs:.1f}s -> {info['frames']}f in {dt:.1f}s{extra}{miss}")
            except Exception as e:
                print(f"[{lang}] {os.path.basename(wav)}: FAILED {e}")
    print("\nlang | files | audio min | bake time | realtime factor")
    for lang in ["en", "ar", "zh", "es", "fr", "de"]:
        if lang in stats:
            n, secs, dt = stats[lang]
            print(f"{lang:4} | {n:5} | {secs/60:9.1f} | {dt:9.1f}s | {secs/max(dt,1e-9):7.1f}x")
    if mismatches:
        print("\nNAME MISMATCHES:")
        for tag, extra, miss in mismatches:
            print(f"  {tag}: extra={extra} missing={miss}")
    else:
        print("\nAll emitted names are exact ARKit-52 matches.")


if __name__ == "__main__":
    main()
