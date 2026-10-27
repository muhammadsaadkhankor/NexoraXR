// Course ingestion — hierarchical: Document → Sections → Concepts → Chunks.
//   PDF → per-page text (provenance preserved) → heading-aware chunks →
//   embeddings → course_chunks; section rows + LLM summaries/concepts →
//   course_sections + course_documents.summary/concepts.
// Embeddings are float8[] compared in JS — no pgvector dependency.

import path from 'node:path';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getPool } from '../db/pool.mjs';
import { embed, chat } from './llm.mjs';

const SERVER_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MATERIALS_DIR = path.join(SERVER_DIR, 'uploads', 'materials');
const TESSDATA_DIR = path.join(SERVER_DIR, 'uploads', 'tessdata');

const CHUNK_WORDS = 700;
const CHUNK_OVERLAP = 120;
const EMBED_BATCH = 50;
// Cap LLM work per document — huge books summarize at section granularity.
const MAX_SECTION_SUMMARIES = 12;
// OCR fallback for image-only/partial-text PDFs (scanned slides).
const OCR_ENABLED = process.env.COURSE_OCR !== '0';
const OCR_MAX_PAGES = Number(process.env.COURSE_OCR_MAX_PAGES || 60);
const OCR_DPI = Number(process.env.COURSE_OCR_DPI || 150);
const OCR_MIN_CHARS = 20; // pages below this are treated as image-only

// pdf-parse with pagerender captures per-page text → page provenance.
export async function parsePdfPages(buf) {
  const pdf = (await import('pdf-parse/lib/pdf-parse.js')).default;
  const pageTexts = [];
  const d = await pdf(buf, {
    pagerender: async (pageData) => {
      const tc = await pageData.getTextContent();
      pageTexts.push(tc.items.map((i) => i.str).join(' '));
      return tc.items.map((i) => i.str).join(' ');
    },
  });
  return { text: d.text || '', pages: d.numpages || pageTexts.length, pageTexts,
    infoTitle: String(d.info?.Title || '').trim() || null };
}

// ---- OCR fallback (tesseract.js WASM + poppler's pdftoppm) --------------------
// Rasterizes ONLY the pages that lack a usable text layer, preserving 1-based
// page numbers and reading order. Math/figures are inherently uncertain —
// callers record `extraction` so review UIs can flag it.
const execFileP = (cmd, args) => new Promise((res, rej) =>
  execFile(cmd, args, { timeout: 120000 }, (e, so, se) => e ? rej(new Error(se || e.message)) : res(so)));

export async function ocrPages(pdfPath, pageNums) {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'nexora-ocr-'));
  const out = new Map();
  try {
    const { createWorker } = await import('tesseract.js');
    const worker = await createWorker('eng', 1, {
      langPath: TESSDATA_DIR, cachePath: TESSDATA_DIR, gzip: true });
    try {
      for (const p of pageNums) {
        await execFileP('pdftoppm', ['-png', '-r', String(OCR_DPI), '-f', String(p), '-l', String(p), pdfPath, path.join(tmp, 'p')]);
        const files = (await fsp.readdir(tmp)).filter((f) => f.endsWith('.png'));
        if (!files.length) continue;
        const png = await fsp.readFile(path.join(tmp, files[0]));
        const r = await worker.recognize(png);
        out.set(p, String(r.data?.text || '').trim());
        for (const f of files) await fsp.unlink(path.join(tmp, f)).catch(() => {});
      }
    } finally {
      await worker.terminate().catch(() => {});
    }
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
  return out;
}

// Fill per-page texts: pages with a usable text layer keep it; sparse/image
// pages are OCRed (bounded). `ocrFn` injectable for tests. Returns
// {texts, ocrPages, ocrFailed}.
export async function fillMissingText(pdfPath, pageTexts, ocrFn = ocrPages) {
  const sparse = pageTexts
    .map((t, i) => ((t || '').replace(/\s/g, '').length < OCR_MIN_CHARS ? i + 1 : null))
    .filter(Boolean)
    .slice(0, OCR_MAX_PAGES);
  if (!OCR_ENABLED || !sparse.length) return { texts: pageTexts, ocrPages: 0, ocrFailed: sparse.length && !OCR_ENABLED };
  const ocr = await ocrFn(pdfPath, sparse);
  const texts = pageTexts.map((t, i) =>
    sparse.includes(i + 1) && (ocr.get(i + 1) || '').length ? ocr.get(i + 1) : t);
  return { texts, ocrPages: ocr.size, ocrFailed: sparse.length - ocr.size };
}

// Heading heuristic + page tracking. Returns
// [{section:{title,pageStart,pageEnd,text}}] then chunk slices per section.
export function parseSections(pageTexts) {
  const sections = [];
  let cur = { title: 'Document start', pageStart: 1, lines: [], pageLines: new Map() };
  const flushSection = (endPage) => {
    if (!cur.lines.length) return;
    // pageLines: exact per-page text — chunking never crosses pages, so a
    // chunk's stamped page is the page its text actually lives on.
    const pageLines = [...cur.pageLines.entries()]
      .map(([page, lines]) => ({ page, text: lines.join('\n') }));
    sections.push({
      title: cur.title, pageStart: cur.pageStart, pageEnd: endPage,
      text: cur.lines.join('\n'), pageLines,
    });
  };
  const pushLine = (page, line) => {
    cur.lines.push(line);
    const arr = cur.pageLines.get(page) || [];
    arr.push(line);
    cur.pageLines.set(page, arr);
  };
  pageTexts.forEach((pageText, pi) => {
    for (const line of pageText.split(/\r?\n|(?<=\.)\s{2,}/)) {
      const t = line.trim();
      const isHeading = t && t.length <= 80 && t.split(/\s+/).length <= 12
        && /[A-Z]/.test(t[0] || '') && !/[.;:]$/.test(t)
        && (t === t.toUpperCase() || /^\d+(\.\d+)*\s/.test(t) || /^(chapter|section|lecture|unit|part)\b/i.test(t));
      if (isHeading && cur.lines.join(' ').split(/\s+/).length > 40) {
        flushSection(pi + 1);
        cur = { title: t, pageStart: pi + 1, lines: [], pageLines: new Map() };
      } else if (t) pushLine(pi + 1, t);
    }
  });
  flushSection(pageTexts.length);
  // PPT-style PDFs yield almost no headings — each page IS a slide. Treat each
  // page as its own section so provenance resolves to the exact slide.
  if (sections.length < 3 && pageTexts.length > 5) {
    return pageTexts
      .map((t, i) => ({
        title: t.split(/\r?\n|(?<=[.!?])\s/).map((x) => x.trim()).find((x) => x.length > 3 && x.length <= 90) || `Page ${i + 1}`,
        pageStart: i + 1, pageEnd: i + 1, text: t,
      }))
      .filter((s) => s.text.trim().length > 0);
  }
  return sections;
}

// Word-bounded chunks per section, keeping provenance. When per-page text is
// available (always for parsed PDFs), chunks NEVER cross page boundaries —
// chunk.page is the exact page the text is on, not merely the section's
// opening page.
export function chunkSection(section, startIdx) {
  const out = [];
  const push = (words, page) => {
    for (let i = 0; i < words.length; i += CHUNK_WORDS - CHUNK_OVERLAP) {
      const slice = words.slice(i, i + CHUNK_WORDS);
      // Tiny trailing slices are dropped ONLY when the page already has a
      // chunk — a sparse page's sole fragment still contributes inventory.
      if (slice.join(' ').trim().length <= 40 && out.some((c) => c.page === page)) break;
      out.push({ heading: section.title, text: slice.join(' '), page, idx: startIdx + out.length });
      if (i + CHUNK_WORDS >= words.length) break;
    }
  };
  if (section.pageLines?.length) {
    for (const { page, text } of section.pageLines) {
      push(text.split(/\s+/).filter(Boolean), page);
    }
    return out;
  }
  push(section.text.split(/\s+/).filter(Boolean), section.pageStart);
  return out;
}

// Compact LLM summaries + concepts per document (bounded calls).
async function summarizeDocument(filename, sections) {
  const caps = sections.slice(0, MAX_SECTION_SUMMARIES);
  const joined = caps.map((s) => `## ${s.title}\n${s.text.slice(0, 1500)}`).join('\n\n');
  try {
    const out = await chat([
      { role: 'system', content:
        `Summarize teaching material for curriculum planning. Return JSON: ` +
        `{"summary":"3-5 sentence document summary","concepts":[{"name":"...",` +
        `"description":"one line","section":"nearest section title"}],` +
        `"sections":[{"title":"...","summary":"1-2 sentences"}]}. ` +
        `Sections array must mirror the input order. Be concrete, no fluff.` },
      { role: 'user', content: `Document: "${filename}"\n\n${joined.slice(0, 30000)}` },
    ], { json: true, maxTokens: 2500 });
    return out;
  } catch (e) {
    console.warn(`[course] summarize failed for ${filename}:`, e.message);
    return { summary: sections[0]?.title || filename, concepts: [], sections: [] };
  }
}

export async function ingestDocument(docId) {
  const pool = getPool();
  const { rows } = await pool.query(`SELECT * FROM course_documents WHERE id=$1`, [docId]);
  const doc = rows[0];
  if (!doc) return;
  await pool.query(`UPDATE course_documents SET status='processing', error=NULL WHERE id=$1`, [docId]);
  try {
    const file = path.join(MATERIALS_DIR, doc.room_id, doc.filename);
    const buf = await fsp.readFile(file);
    const { pages, pageTexts, infoTitle } = await parsePdfPages(buf);
    // Sparse/image-only pages get OCR; normal PDFs skip it entirely.
    const { texts: filledTexts, ocrPages, ocrFailed } = await fillMissingText(file, pageTexts);
    const effectiveTexts = filledTexts.length ? filledTexts : [buf.toString('utf8')];
    const sections = parseSections(effectiveTexts);
    const allChunks = sections.flatMap((s) => chunkSection(s, 0));
    if (!allChunks.length) {
      throw new Error(ocrPages
        ? 'OCR ran but produced no usable text — the PDF may be corrupt'
        : 'No extractable text — the PDF may be image-only or malformed');
    }
    const hadTextLayer = pageTexts.some((t) => (t || '').replace(/\s/g, '').length >= OCR_MIN_CHARS);
    const extraction = ocrPages ? (hadTextLayer ? 'partial' : 'ocr')
      : hadTextLayer ? 'text' : 'ocr'; // OCR ran but produced nothing usable → throws above

    // Re-ingest cleanly.
    await pool.query(`DELETE FROM course_chunks WHERE document_id=$1`, [docId]);
    await pool.query(`DELETE FROM course_sections WHERE document_id=$1`, [docId]);

    // Section rows (embedded on their summaries later).
    const sectionRows = [];
    for (const [i, s] of sections.entries()) {
      const id = crypto.randomUUID();
      sectionRows.push(id);
      await pool.query(
        `INSERT INTO course_sections (id, document_id, course_id, idx, title, page_start, page_end)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [id, docId, doc.course_id, i, s.title, s.pageStart, s.pageEnd]);
    }

    for (let i = 0; i < allChunks.length; i += EMBED_BATCH) {
      const slice = allChunks.slice(i, i + EMBED_BATCH);
      const vectors = await embed(slice.map((c) => `${c.heading}\n${c.text}`));
      for (let j = 0; j < slice.length; j++) {
        const c = slice[j];
        const sIdx = sections.findIndex((s) => s.title === c.heading);
        await pool.query(
          `INSERT INTO course_chunks (id, document_id, course_id, idx, heading, text, page, section_id, embedding)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [crypto.randomUUID(), docId, doc.course_id, c.idx, c.heading, c.text, c.page,
           sIdx >= 0 ? sectionRows[sIdx] : null, vectors[j]]);
      }
    }

    // LLM hierarchy enrichment — failures degrade to plain ingest, not errors.
    const summary = await summarizeDocument(doc.filename, sections);
    if (summary.sections?.length) {
      for (const [i, s] of sections.entries()) {
        const sum = summary.sections[i]?.summary || null;
        if (sum) {
          const [vec] = await embed([sum]).catch(() => [null]);
          await pool.query(`UPDATE course_sections SET summary=$2, embedding=$3 WHERE id=$1`,
            [sectionRows[i], sum, vec]);
        }
      }
    }
    await pool.query(
      `UPDATE course_documents SET status='ready', pages=$2, summary=$3, concepts=$4, title=$5, extraction=$6 WHERE id=$1`,
      [docId, pages, summary.summary || null, JSON.stringify(summary.concepts || []), infoTitle, extraction]);
    console.log(`[course] ingested ${doc.filename}: ${sections.length} sections, ${allChunks.length} chunks`);
  } catch (err) {
    await pool.query(`UPDATE course_documents SET status='failed', error=$2 WHERE id=$1`,
      [docId, String(err.message || err).slice(0, 400)]);
    console.error(`[course] ingest failed for ${doc.filename}:`, err.message);
  }
}

// Register an uploaded file as a course document; dedup by content hash.
export async function registerDocument({ courseId, roomId, filename, buf, userId }) {
  const pool = getPool();
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  const { rows: existing } = await pool.query(
    `SELECT id, status FROM course_documents WHERE course_id=$1 AND sha256=$2`, [courseId, sha256]);
  if (existing[0]) return { doc: existing[0], duplicate: true };
  const id = crypto.randomUUID();
  const { rows } = await pool.query(
    `INSERT INTO course_documents (id, course_id, room_id, filename, bytes, sha256, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [id, courseId, roomId, filename, buf.length, sha256, userId]);
  return { doc: rows[0], duplicate: false };
}
