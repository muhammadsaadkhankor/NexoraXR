#!/usr/bin/env python3
"""Query the lecture RAG index.

Usage:
  python query_rag.py "What is a digital twin?"
  python query_rag.py "What is a digital twin?" --top-k 4 --answer
"""

import argparse
import json
import os
import urllib.request
from pathlib import Path

try:
    from sklearn.feature_extraction.text import TfidfVectorizer
    from sklearn.metrics.pairwise import cosine_similarity
except ImportError:
    print("scikit-learn is required. Install with: pip install scikit-learn")
    raise

ROOT = Path(__file__).resolve().parent
LECTURES_DIR = ROOT / "lectures"
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "qwen2.5:1.5b")


def load_chunks():
    chunks = []
    for lecture_dir in LECTURES_DIR.glob("Lecture_*"):
        chunks_file = lecture_dir / "chunks.json"
        if not chunks_file.exists():
            continue
        with open(chunks_file, encoding="utf-8") as f:
            data = json.load(f)
        for c in data.get("chunks", []):
            chunks.append({
                "id": c["id"],
                "lecture_id": data["lecture_id"],
                "title": data["title"],
                "text": c["text"],
            })
    return chunks


def build_index(chunks):
    texts = [c["text"] for c in chunks]
    vectorizer = TfidfVectorizer(stop_words="english", max_features=5000)
    matrix = vectorizer.fit_transform(texts)
    return vectorizer, matrix, chunks


def retrieve(query, vectorizer, matrix, chunks, top_k=4):
    query_vec = vectorizer.transform([query])
    similarities = cosine_similarity(query_vec, matrix)[0]
    ranked = sorted(enumerate(similarities), key=lambda x: x[1], reverse=True)
    results = []
    for idx, score in ranked[:top_k]:
        r = chunks[idx].copy()
        r["score"] = float(score)
        results.append(r)
    return results


def ollama_answer(query, context):
    prompt = f"""You are a helpful Multimedia Computing tutor. Use the following lecture context to answer the student's question in 2-3 sentences.

Context:
{context}

Question: {query}

Answer:"""
    payload = {
        "model": OLLAMA_MODEL,
        "prompt": prompt,
        "stream": False,
        "options": {"temperature": 0.5, "num_predict": 200, "num_gpu": 0},
    }
    req = urllib.request.Request(
        f"{OLLAMA_URL}/api/generate",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    return data.get("response", "").strip()


def main():
    parser = argparse.ArgumentParser(description="Query the lecture RAG index")
    parser.add_argument("query", help="The question to ask")
    parser.add_argument("--top-k", type=int, default=4, help="Number of chunks to retrieve")
    parser.add_argument("--answer", action="store_true", help="Also generate an answer with Ollama")
    args = parser.parse_args()

    chunks = load_chunks()
    if not chunks:
        print("No chunks found. Run prep_lectures.py first.")
        return

    print(f"Loaded {len(chunks)} chunks. Building TF-IDF index...")
    vectorizer, matrix, chunks = build_index(chunks)

    results = retrieve(args.query, vectorizer, matrix, chunks, top_k=args.top_k)
    print("\nTop retrieved chunks:")
    context = []
    for r in results:
        print(f"\n[{r['lecture_id']}] score={r['score']:.3f}\n{r['text'][:400]}...")
        context.append(r["text"])

    if args.answer:
        print("\n--- Generated answer ---")
        answer = ollama_answer(args.query, "\n\n---\n\n".join(context))
        print(answer)


if __name__ == "__main__":
    main()
