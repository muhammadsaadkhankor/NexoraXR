#!/usr/bin/env python3
"""Pre-generate TTS audio for all 5-minute lecture summaries.

Reads profbrain/lectures/Lecture_N/summary.json
Calls CosyVoice on localhost:5000/synthesize
Writes profbrain/lectures/Lecture_N/summary.wav and summary_audio.json

To avoid GPU OOM, each summary is split into ~200-word chunks, each chunk is
synthesized, and the PCM output is concatenated into one WAV file.
"""

import json
import os
import re
import struct
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
COSYVOICE_URL = os.environ.get("COSYVOICE_URL", "http://localhost:5000")
VOICE_ID = os.environ.get("COSYVOICE_VOICE", "prof")
CHUNK_WORDS = 180
SAMPLE_RATE = 24000


def split_text(text, max_words=CHUNK_WORDS):
    """Split text into chunks of at most max_words, keeping sentences intact."""
    sentences = re.split(r"(?<=[.!?])\s+", text.strip())
    chunks = []
    current = []
    current_len = 0
    for s in sentences:
        s = s.strip()
        if not s:
            continue
        words = s.split()
        if current_len + len(words) > max_words and current:
            chunks.append(" ".join(current))
            current = [s]
            current_len = len(words)
        else:
            current.append(s)
            current_len += len(words)
    if current:
        chunks.append(" ".join(current))
    return chunks


def pcm16_to_wav(pcm_bytes, sample_rate=SAMPLE_RATE, channels=1):
    data_size = len(pcm_bytes)
    total_size = 44 + data_size
    wav = bytearray(total_size)

    def set_u32(off, v):
        struct.pack_into("<I", wav, off, v)

    def set_u16(off, v):
        struct.pack_into("<H", wav, off, v)

    # RIFF header
    wav[0:4] = b"RIFF"
    set_u32(4, total_size - 8)
    wav[8:12] = b"WAVE"
    wav[12:16] = b"fmt "
    set_u32(16, 16)
    set_u16(20, 1)          # PCM
    set_u16(22, channels)
    set_u32(24, sample_rate)
    set_u32(28, sample_rate * channels * 2)
    set_u16(32, channels * 2)
    set_u16(34, 16)
    wav[36:40] = b"data"
    set_u32(40, data_size)
    wav[44:] = pcm_bytes
    return bytes(wav)


def synthesize_chunk(text, voice_id=VOICE_ID):
    boundary = "----Boundary" + str(time.time())
    body = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="tts_text"\r\n\r\n'
        f"{text}\r\n"
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="voice_id"\r\n\r\n'
        f"{voice_id}\r\n"
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="stream"\r\n\r\n'
        f"false\r\n"
        f"--{boundary}--\r\n"
    ).encode("utf-8")

    req = urllib.request.Request(
        f"{COSYVOICE_URL}/synthesize",
        data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=180) as resp:
        return resp.read()


def process_lecture(n, force=False):
    out_dir = ROOT / "lectures" / f"Lecture_{n}"
    summary_path = out_dir / "summary.json"
    audio_path = out_dir / "summary.wav"
    meta_path = out_dir / "summary_audio.json"

    if not summary_path.exists():
        print(f"[Lecture {n}] summary.json not found; run prep_lectures.py first.")
        return

    if not force and audio_path.exists() and meta_path.exists():
        print(f"[Lecture {n}] audio already prepared. Use --force to regenerate.")
        return

    data = json.loads(summary_path.read_text(encoding="utf-8"))
    text = data["text"]
    chunks = split_text(text)
    print(f"[Lecture {n}] Summary is {len(text.split())} words, split into {len(chunks)} chunks.")

    pcm_parts = []
    for i, chunk in enumerate(chunks, 1):
        print(f"[Lecture {n}] Synthesizing chunk {i}/{len(chunks)} ({len(chunk.split())} words)...")
        t0 = time.time()
        try:
            pcm = synthesize_chunk(chunk)
            print(f"[Lecture {n}] Chunk {i} done in {time.time()-t0:.1f}s ({len(pcm)} bytes)")
            pcm_parts.append(pcm)
        except Exception as e:
            print(f"[Lecture {n}] Chunk {i} failed: {e}")
            raise

    full_pcm = b"".join(pcm_parts)
    wav = pcm16_to_wav(full_pcm)
    audio_path.write_bytes(wav)
    duration = len(full_pcm) / (2 * SAMPLE_RATE)  # 16-bit mono

    meta = {
        "lecture_id": f"Lecture_{n}",
        "title": data.get("title", f"Lecture {n}"),
        "audio_path": str(audio_path),
        "duration_seconds": round(duration, 2),
        "text_word_count": len(text.split()),
        "chunks": len(chunks),
        "voice_id": VOICE_ID,
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
    }
    meta_path.write_text(json.dumps(meta, indent=2), encoding="utf-8")
    print(f"[Lecture {n}] Saved {audio_path} ({duration:.1f}s)")


def main():
    import sys
    force = "--force" in sys.argv
    only = None
    for arg in sys.argv[1:]:
        if arg.startswith("--lecture="):
            only = int(arg.split("=", 1)[1])

    for n in range(1, 9):
        if only and n != only:
            continue
        process_lecture(n, force=force)

    print("\nAll TTS audio prepared.")


if __name__ == "__main__":
    main()
