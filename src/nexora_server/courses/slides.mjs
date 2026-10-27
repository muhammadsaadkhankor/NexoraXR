// Slide-deck synthesis for generated lectures — real PDF in the same slot
// Multimedia uses (the board next to the professor). Concise slide content
// comes from planSlides(); this module only RENDERS.
//
// pdfkit gotcha (learned the hard way): text() calls are buffered and flushed
// onto the page where the NEXT graphics op runs — interleaving text and
// graphics bleeds text onto the following page. Rule per slide: graphics
// first, ALL text() calls contiguous, then a 1px rect to flush.

import path from 'node:path';
import fs from 'node:fs';

const PDFKit = (await import('pdfkit')).default;

const BG = '#0b1020';
const ACCENT = '#22d3ee';
const TEXT = '#e5e9f0';
const MUTED = '#9aa4b8';

const flush = (doc) => doc.rect(0, 0, 1, 1).fill(BG); // forces text flush, see above

function decorate(doc) {
  const { width, height } = doc.page;
  doc.rect(0, 0, width, height).fill(BG);
  doc.rect(0, 0, 8, height).fill(ACCENT);
}

// Writes slides.pdf into dir; fills slideMap {segmentIndex→page}.
// slidesPlan: [{forSection(1-based), title, bullets[], formula?}].
// visualPages: {slideIdx(1-based)→png path} — real source-PDF pages rendered
// with pdftoppm; the slide shows the original PPT/book page full-bleed.
export async function writeSlides(dir, lecture, { courseName = '', slidesPlan = null, slideMap = null, visualPages = {} } = {}) {
  const doc = new PDFKit({ layout: 'landscape', size: 'LETTER', margin: 60 });
  const file = path.join(dir, 'slides.pdf');
  const stream = fs.createWriteStream(file);
  doc.pipe(stream);

  let page = 1;

  // Cover
  decorate(doc);
  doc.moveDown(2);
  doc.fontSize(34).font('Helvetica-Bold').fillColor(TEXT)
    .text(lecture.title, { align: 'center', lineGap: 8 });
  if (courseName) doc.moveDown(1).fontSize(16).font('Helvetica').fillColor(ACCENT)
    .text(courseName, { align: 'center' });
  doc.moveDown(1.5).fontSize(14).fillColor(MUTED)
    .text(`${(slidesPlan?.length || lecture.sections.length)} slides`, { align: 'center' });
  flush(doc);

  const slides = slidesPlan?.length ? slidesPlan
    : lecture.sections.map((s, i) => ({ forSection: i + 1, title: s.title, bullets: [] }));

  // For each section find which slide covers it (contiguous merge-friendly).
  const slideForSection = new Map();
  slides.forEach((sl, si) => {
    const sec = Number(sl.forSection) || si + 1;
    slideForSection.set(sec, si + 2); // slide page = cover(1)+index
  });
  // Sections not covered by any slide: attach to the nearest previous slide.
  let segIdx = 0;
  const sectionPage = lecture.sections.map((s, i) =>
    slideForSection.get(i + 1) || slideForSection.get([...slideForSection.keys()].filter((k) => k <= i + 1).pop()) || 2);
  const slideOf = (secIdx) => {
    // If this section begins a new slide's coverage, that slide's page —
    // else share the previous slide's page.
    return sectionPage[secIdx];
  };

  slides.forEach((sl, i) => {
    doc.addPage();
    page += 1;
    decorate(doc);
    const img = visualPages[i + 1];
    if (img) {
      // Real source page — PPT slide / book page shown as-is, full-bleed.
      try {
        const { width, height } = doc.page;
        doc.image(img, 8, 0, { fit: [width - 8, height - 40], align: 'center', valign: 'center' });
        doc.fontSize(10).fillColor(MUTED).text(`${i + 1} / ${slides.length}`, 60, doc.page.height - 50);
        flush(doc);
      } catch (e) {
        console.warn(`[slides] image embed failed for slide ${i + 1}:`, e.message);
      }
    } else {
      doc.moveTo(60, 110).lineTo(220, 110).lineWidth(2).stroke(ACCENT);
      doc.fontSize(24).font('Helvetica-Bold').fillColor(TEXT).text(String(sl.title || ''), 60, 60, { width: 670 });
      const lines = (sl.bullets || []).filter(Boolean).map((b) => `• ${String(b).trim()}`);
      if (sl.formula) lines.push(`»  ${String(sl.formula).trim()}`);
      doc.font('Helvetica').fontSize(15).fillColor(TEXT)
        .text(lines.join('\n') || '', 70, 140, { width: 620, lineGap: 8 });
      doc.fontSize(10).fillColor(MUTED).text(`${i + 1} / ${slides.length}`, 60, doc.page.height - 50);
      flush(doc);
    }
  });

  doc.end();
  await new Promise((res, rej) => { stream.on('finish', res); stream.on('error', rej); });

  // segment → slide page (each paragraph segment shows its section's slide)
  if (slideMap) {
    lecture.sections.forEach((s, si) => {
      const pg = slideOf(si);
      for (const _p of (s.segments || s.paragraphs || [])) slideMap[segIdx++] = pg;
    });
  }
  return slideMap;
}
