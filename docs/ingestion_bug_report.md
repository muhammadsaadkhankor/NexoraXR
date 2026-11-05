# Ingestion bug report — Lec1_Introduction.pdf (ELG 5255)

## 1. course_documents row (before fix)

| field | value |
|-------|-------|
| filename | `Lec1_Introduction.pdf` |
| status | `processing` (stuck — never completed, never failed) |
| error | `NULL` |
| pages | `NULL` |

The UI message "Documents were uploaded but none produced usable text
(image-only or corrupt PDF)" was shown because `pollPlanPreview` timed out
(120 × 2 s) while the doc sat in `processing` — the failure branch never
ran, so no `error` was ever recorded.

## 2. Pipeline steps run directly on the PDF — all pass

| step | result |
|------|--------|
| `parsePdfPages` (pdf-parse + pagerender) | 30 pages in ~95 ms; every page has a text layer |
| per-page text length | 16–896 chars; 5 sparse title-only slides (p18, 20, 21, 24, 27 < 20 non-space chars) |
| `fillMissingText` / OCR | 2 pages OCRed, 0 failed, ~1.3 s |
| `parseSections` | 30 sections (slide-deck fallback — one section per page) |
| `chunkSection` | 30 chunks |
| `embed` (Ollama `nomic-embed-text`) | 768-dim vectors, ~1 s |
| `chat` (qwen3:8b summarize) | ok |

`ingestDocument` run standalone: `status='ready'`, `pages=30`,
`extraction='partial'` (text layer + 2 OCRed pages), 30 sections + 30
chunks, real summary written.

## 3. Dependencies

- `pdf-parse` — installed and working (`pagerender` per-page path).
- `pdftoppm` — `/usr/bin/pdftoppm` present.
- `tesseract.js` — installed; OCR exercised above.
- Embeddings — Ollama `nomic-embed-text` reachable at `localhost:11434`;
  chat model `qwen3:8b` reachable.

## 4. Root cause

Not a PDF problem at all. The doc's ingestion was running inside the
backend process when that process was killed (server restart). Nothing
recovered stuck `processing` documents on boot — unlike `course_builds`,
which already resume via `resumeInterrupted()`. The doc stayed
`processing` forever; `plan-preview` kept returning `lectures: []`; the
client showed its generic "image-only or corrupt" fallback for **any**
timeout, masking the real state.

## 5. Fixes

- `courses/pipeline.mjs`
  - `resumeInterruptedDocs()` — on boot, re-ingests documents left in
    `processing` (same convention as `resumeInterrupted` for builds);
    wired into `initDb` startup in `server.js`.
  - Stage tracking — `course_documents.error` now records the failing
    stage, e.g. `Embedding (batch 1) failed: ollama embeddings: …`,
    `OCR failed: …`, `PDF text extraction failed: …`.
- `CreateClassroomModal.jsx`
  - `pollPlanPreview` returns the last preview payload on timeout instead
    of `null`, so the UI can show actual per-document errors.
  - The no-lectures path now prints the real `course_documents.error`
    per file when present (the `failed` branch already did) and explains
    interruption when docs are still processing — instead of always
    blaming image-only/corrupt PDFs.
  - Failed-doc error text no longer duplicates the word "failed".

## 6. Verification

- Boot recovery verified live: doc forced back to `processing` → server
  restart → `[course] resuming interrupted ingest for Lec1_Introduction.pdf`
  → `ingested … 30 sections, 30 chunks` → `status='ready'`.
- **1 PDF + lecture count 2** → `buildOutline(course, 2)` produced two
  lectures split across the document (admin/syllabus pages excluded by
  the `isAdminText` inventory filter):
  - L1 *"Introduction to Machine Learning and Its Applications"* — pages
    [10–15, 18, 20–21, 24, 30]
  - L2 *"Mathematical Foundations and Core Concepts of Machine Learning"* —
    pages [9, 22]
- `pipeline.test.mjs` + `generator.test.mjs`: 12/12 pass. Client build ok.

## Not fixed / notes

- If a doc legitimately fails (true image-only PDF, embed down), the
  error is now accurate, but auto-recovery only covers the
  killed-mid-ingest case — genuinely `failed` docs still need the
  Retry button (`/reingest`), by design.
