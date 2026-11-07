# ChatGPT Prompt — Generate a Lecture in NexoraXR Format

Replace `[YOUR TOPIC]`, `[COURSE NAME]`, and the lecture title, then paste the
block below into ChatGPT. Save each output file under
`profbrain/lectures/my_L1/` (translation files into `profbrain/lectures/my_L1/translations/`).

---

## The prompt

```
Write a lecture script for me in a strict JSON file format. I will paste your
output into my system as-is, so output ONLY valid JSON files, no prose, no
explanations, no markdown fences.

Lecture: "[YOUR TOPIC]" — a university-level lecture, ~10 segments. Each
segment is 3–5 sentences of natural spoken-lecture narration (first-person
professor voice, warm tone).

File 1 — summary.json:
{"lecture_id":"my_L1","title":"Lecture 1: <title>","text":"<all English segment texts joined by exactly one blank line>","word_count":<count>,"model":"generated","generated":true,"created_at":"2026-11-06T00:00:00.000Z"}

File 2 — segments.json:
{"lectureId":"my_L1","title":"Lecture 1: <title>","course":"<course name>","segments":[{"id":0,"section":"<short heading>","text":"<segment text>"}]}

Files 3–7 — one per language: ar.json, fr.json, de.json, es.json, zh.json:
{"lang":"<lang>","lectureId":"my_L1","version":0,"basedOnVersion":0,"edited":false,"segments":[{"id":0,"text":"<translated text>"}]}

Rules:
- Same segment ids and count in every file; translate faithfully, same
  meaning and style.
- Technical terms: on first use write "translated term (english term)" —
  e.g. Arabic: "التعلم الآلي (machine learning)", French: "apprentissage
  automatique (machine learning)".
- Write ONLY in the target language and its native script — no English
  sentences inside translations except the bracketed technical terms.
- No headings, no speaker labels, no stage directions — only narration text
  in `text` fields.

Output all 7 files in order: summary.json, segments.json, ar.json, fr.json,
de.json, es.json, zh.json — each with its filename as a comment line above it.
```

---

## After ChatGPT replies — file layout

```
profbrain/lectures/my_L1/
├── summary.json
├── segments.json
└── translations/
    ├── ar.json
    ├── fr.json
    ├── de.json
    ├── es.json
    └── zh.json
```

## Bake the audio (VoxCPM2 must be running on :8010)

```bash
cd src/nexora_server
node -e "
import('./courses/bake.mjs').then(async ({bakeLecture, warmLectureUtterances}) => {
  for (const lang of ['en','ar','fr','de','es','zh']) {
    await bakeLecture('my_L1', lang);
    await warmLectureUtterances('my_L1', lang);
    console.log(lang, 'done');
  }
})"
```

Output WAVs land in `src/nexora_ai/lecture_cache/segments/my_L1__<lang>/segment_NNN.wav`,
each Whisper-verified per 3-second window.
