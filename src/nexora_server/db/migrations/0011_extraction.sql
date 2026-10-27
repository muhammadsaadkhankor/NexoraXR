-- Extraction provenance: 'text' (native layer), 'partial' (mixed/OCR-assist),
-- 'ocr' (image-only, fully OCRed). NULL for docs ingested before this column.
ALTER TABLE course_documents
  ADD COLUMN IF NOT EXISTS extraction text;
