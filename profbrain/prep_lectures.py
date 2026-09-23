#!/usr/bin/env python3
"""Prepare 5-minute professor explanations and RAG chunks for each lecture.

Reads PDFs from profbrain/raw_pdfs/.
Writes to profbrain/lectures/Lecture_N/:
  - lecture_notes.txt  (cleaned full text)
  - summary.json       (5-10 minute spoken explanation, ~700 words)
  - chunks.json        (RAG-ready 300-word chunks)
"""

import glob
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
RAW_DIR = ROOT / "raw_pdfs"
LECTURES_DIR = ROOT / "lectures"
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "qwen2.5:1.5b")

TITLE_MAP = {
    1: "Multimedia Computing: Concepts and Definitions",
    2: "Multimedia Computing: Data Sources",
    3: "Multimedia Computing: Compression",
    4: "Multimedia Computing: Multimedia Interactions",
    5: "Multimedia Computing: Digital Twins & AI-Powered Metaverses",
    6: "Multimedia Computing: Security",
    7: "Multimedia Computing: Quality of Experience",
    8: "Multimedia Computing: AI in Multimedia",
}


def get_lecture_number(path):
    m = re.search(r"Lecture\s*(\d+)", os.path.basename(path), re.I)
    return int(m.group(1)) if m else None


def extract_pdf_text(pdf_path):
    result = subprocess.run(
        ["pdftotext", str(pdf_path), "-"],
        capture_output=True,
        text=True,
        check=True,
    )
    return result.stdout


def clean_text(raw):
    raw = raw.replace("\x0c", "\n")

    def keep(line):
        s = line.strip()
        if not s:
            return False
        if s.startswith("\u00a9") or "MCRLab" in s or "mcrlab" in s.lower():
            return False
        if "elsaddik" in s.lower() or "abdulmotaleb" in s.lower():
            return False
        if s.startswith("www.") or s.startswith("http"):
            return False
        if re.fullmatch(r"\d+", s):
            return False
        if s in {"Distinguished Professor", "Multimedia Communications Research Lab",
                 "FRSC, FIEEE, FCAE, FEIC"}:
            return False
        if any(x in s.lower() for x in ["linkedin", "twitter", "instagram"]):
            return False
        return True

    lines = [l for l in raw.splitlines() if keep(l)]
    return "\n".join(lines)


def chunk_text(text, chunk_size=300, overlap=50):
    paragraphs = [p.strip() for p in text.split("\n\n") if p.strip()]
    chunks = []
    current = []
    current_len = 0
    for para in paragraphs:
        para_words = para.split()
        if current_len + len(para_words) > chunk_size and current:
            chunks.append("\n\n".join(current))
            if overlap:
                # keep last overlap words as overlap
                last = current[-1].split()
                overlap_text = " ".join(last[-overlap:]) if len(last) > overlap else current[-1]
                current = [overlap_text, para]
                current_len = len(overlap_text.split()) + len(para_words)
            else:
                current = [para]
                current_len = len(para_words)
        else:
            current.append(para)
            current_len += len(para_words)
    if current:
        chunks.append("\n\n".join(current))
    return chunks


def ollama_generate(prompt, num_predict=1000):
    payload = {
        "model": OLLAMA_MODEL,
        "prompt": prompt,
        "stream": False,
        "options": {
            "temperature": 0.6,
            "num_predict": num_predict,
            "num_gpu": 0,
        },
    }
    req = urllib.request.Request(
        f"{OLLAMA_URL}/api/generate",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=600) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    return data.get("response", "").strip()


def generate_summary(title, lecture_notes, target_words=700):
    prompt = f"""You are a warm, knowledgeable university professor teaching a Multimedia Computing course.

Lecture: {title}

Full lecture notes:
{lecture_notes}

Please deliver a spoken-style explanation of this lecture that a student can listen to for about 5 minutes. Target around {target_words} words. Do not read every slide. Instead, summarize the key concepts, connect them together, and use a friendly, conversational tone. Explain what the lecture is about, why it matters, and the most important takeaways. End with one complete sentence."""

    # estimate tokens: words * 1.3
    num_predict = int(target_words * 1.4)
    return ollama_generate(prompt, num_predict=num_predict)


def process_lecture(pdf_path, force=False):
    n = get_lecture_number(pdf_path)
    if n is None:
        print(f"[skip] Could not determine lecture number for {pdf_path}")
        return

    title = TITLE_MAP.get(n, f"Lecture {n}")
    out_dir = LECTURES_DIR / f"Lecture_{n}"
    out_dir.mkdir(parents=True, exist_ok=True)

    notes_path = out_dir / "lecture_notes.txt"
    summary_path = out_dir / "summary.json"
    chunks_path = out_dir / "chunks.json"

    if not force and notes_path.exists() and summary_path.exists() and chunks_path.exists():
        print(f"[Lecture {n}] already prepared. Use --force to regenerate.")
        return

    print(f"[Lecture {n}] Extracting PDF...")
    raw = extract_pdf_text(pdf_path)
    cleaned = clean_text(raw)
    notes_path.write_text(cleaned, encoding="utf-8")

    print(f"[Lecture {n}] Chunking for RAG...")
    chunks = chunk_text(cleaned, chunk_size=300, overlap=50)
    chunks_path.write_text(json.dumps({
        "lecture_id": f"Lecture_{n}",
        "title": title,
        "chunks": [{"id": f"Lecture_{n}_chunk_{i}", "text": c} for i, c in enumerate(chunks)]
    }, indent=2), encoding="utf-8")

    if force or not summary_path.exists():
        print(f"[Lecture {n}] Generating 5-minute summary with Ollama...")
        t0 = time.time()
        summary = generate_summary(title, cleaned, target_words=700)
        print(f"[Lecture {n}] Summary done in {time.time() - t0:.1f}s ({len(summary.split())} words)")
        summary_path.write_text(json.dumps({
            "lecture_id": f"Lecture_{n}",
            "title": title,
            "text": summary,
            "word_count": len(summary.split()),
            "model": OLLAMA_MODEL,
            "created_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        }, indent=2), encoding="utf-8")

    print(f"[Lecture {n}] Done. Output in {out_dir}")


def main():
    force = "--force" in sys.argv
    only = None
    for arg in sys.argv[1:]:
        if arg.startswith("--lecture="):
            only = int(arg.split("=", 1)[1])

    pdfs = sorted(glob.glob(str(RAW_DIR / "*.pdf")))
    if not pdfs:
        print(f"No PDFs found in {RAW_DIR}")
        return

    for pdf in pdfs:
        n = get_lecture_number(pdf)
        if only and n != only:
            continue
        process_lecture(pdf, force=force)

    print("\nAll prepared. You can now run profbrain/query_rag.py for Q&A.")


if __name__ == "__main__":
    main()
