# NexoraXR — System Evaluation Plan

System under test: AI virtual classroom — avatar professor delivering a
lecture (my_L1, Linear Regression, ChatGPT-authored script) in 6 languages
(en, ar, zh, es, fr, de) with voice-cloned TTS (stream-tts/VoxCPM),
Audio2Face-3D baked lip-sync + spectral fallback, slide auto-advance,
multi-client sync protocol (NCIP), student floor/questions, and live
LLM answers (qwen3:8b via Ollama).

Goal: produce defensible numbers for the thesis — quality, sync accuracy,
latency, robustness, and resource cost.

---

## 1. Research questions

- **RQ1 (Lipsync):** Do baked Audio2Face-3D tracks improve perceived
  lip-sync quality over the spectral classifier — and does the gain hold
  for non-English languages (ar, zh)?
- **RQ2 (Speech quality):** Is the cloned TTS intelligible and
  speaker-consistent across all 6 languages?
- **RQ3 (Translation):** Does the LLM translation pipeline produce
  validator-clean output with minimal retries after the repair fix?
- **RQ4 (Sync correctness):** Do slides, audio, lip movement, and
  cross-client playback stay aligned during a full lecture — including
  pause/resume, interruption, and language switch?
- **RQ5 (Responsiveness):** Are utterance/answer latencies inside
  classroom-tolerable bounds?
- **RQ6 (Robustness):** Do reconnects, floor interrupts, mid-lecture
  language switches, and unbaked-content fallbacks degrade gracefully?
- **RQ7 (Cost):** What does the full 6-language lecture cost to build
  (time, VRAM, files)?

---

## 2. Metrics by area

### 2.1 Lip-sync quality (RQ1)

| Metric | How to measure | Target |
|---|---|---|
| Subjective quality MOS | 5–10 raters × both modes × ≥2 languages; 1–5 scale | A2F ≥ 4.0, ≥ +0.5 over spectral |
| Preference rate (ABX) | Same clip both modes, blinded, "which looks better" | A2F preferred ≥ 70% |
| Mouth–audio alignment | A2F `jawOpen` energy vs audio RMS envelope → cross-correlate → offset ms | offset < 80 ms |
| Coverage | fraction of speech frames with non-silence jaw activity | A2F > spectral |
| Per-language parity | same MOS/offset measurements on ar + zh | no meaningful drop vs en |

Method for alignment (fully automatic, no rater needed):
`xcorr(jawOpen_weight[t], rms(audio)[t])` on the baked track vs its WAV —
peak lag = effective sync error. Do the same on the spectral path only
indirectly (record screen + extract audio offset), or skip and rely on
MOS/ABX for spectral.

A/B mode: `?lipsync=a2f` vs `?lipsync=spectral` — same segment, same audio.

### 2.2 TTS / voice quality (RQ2)

| Metric | How | Target |
|---|---|---|
| Intelligibility (WER) | Whisper-transcribe each generated WAV, WER vs source text (whisper_service.py already exists) | en < 10%, each lang < 15% |
| Naturalness MOS | raters, 1–5 | ≥ 4.0 en, ≥ 3.5 others |
| Speaker similarity | rater compares reference voice clip vs generated ("same speaker?" 1–5), or cosine similarity of speaker embeddings | ≥ 4.0 en, ≥ 3.5 others |
| Generation speed | already measured: ~3× realtime; re-time per segment | ≥ 3× rt |
| Latency per 45 s segment | time `/generate` E2E | ≤ 15 s |

### 2.3 Translation pipeline (RQ3)

Instrumented already — grep `logs/backend.log`:

| Metric | How | Target |
|---|---|---|
| Rejection rate | count `[translate] rejected` / total translate calls | < 10% |
| Repair rate | count `[translate] repaired` / total calls | record |
| Rescued rate | `[translate] strong-model rescue` count | low single digits |
| Validator-clean rate | final output passing validateTranslation | 100% (validator enforces) |
| Wrong-language incidents | spot-check generated `__<lang>` txts vs expected | 0 |
| Retries per segment | attempts histogram | mean ≤ 1.2 |

### 2.4 Sync correctness (RQ4)

| Metric | How | Target |
|---|---|---|
| Slide–segment alignment | for each segment, shown page == `segments.json` page | 10/10 |
| Cross-client audio drift | `[LECTURE_SYNC] corrected Xs` log entries | < 2 corrections/min, |diff| < 0.35 s |
| Audio–text match | played text == segment text (log `[AUDIO START]`) | 10/10 |
| Pause/resume integrity | resume continues from same position (resumeAt honored) | ±0.5 s |
| Language switch continuity | switch mid-segment N → next message in new lang w/ correct audio+track | works, ≤ 1 segment latency |
| A2F track presence | every my_L1 message has a2fUrl; bin fetch 200 | 60/60 segments + 12/12 utts |

### 2.5 Latency (RQ5)

| Metric | How | Target |
|---|---|---|
| Baked segment start delay | professor-speak → audio 'playing' | < 1 s |
| Dynamic utterance (opening/closing) | decide → audio start | < 10 s warm |
| Student answer E2E | question submitted → professor answers | < 15 s warm (ollama loaded) |
| Cold answer (model evicted) | first question after idle | < 30 s |
| a2f track fetch | meta + bin fetch time | < 200 ms local |

### 2.6 Robustness (RQ6)

Scenario tests — each is pass/fail + observed behavior:

| # | Scenario | Expected |
|---|---|---|
| R1 | Kill backend mid-lecture, restart, reconnect | lecture resumes from state (snapshot + resumeAt) |
| R2 | Client disconnects 15 s, rejoins | grace window → resume without replay |
| R3 | Student takes floor mid-segment | professor pauses (audio+track), resumes on release |
| R4 | Switch language mid-lecture | next unit in new language, correct lipsync source |
| R5 | Unit without baked A2F track (ad-hoc answer) | spectral fallback, no error, no frozen mouth |
| R6 | `?lipsync=spectral` forced | old pipeline everywhere, no a2f fetch attempts failing |
| R7 | NIM down while track exists | nothing breaks (tracks are files — no runtime dep) |
| R8 | Network jitter (throttle client) | drift-corrector keeps audio within tolerance |

### 2.7 Build cost (RQ7)

| Metric | Value (measured today) |
|---|---|
| TTS bake 6 langs (~40 min audio) | ~13 min @ ~3× rt |
| A2F bake 72 files | ~15 min @ ~2.6× rt |
| Script gen (qwen3:8b) | measure on next build |
| Translation 5 langs × 10 segs | measure; watch repaired/rejected |
| Total build E2E | measure |
| VRAM peak during bake | ~19 GB (all services up) |
| Live-class resident VRAM | ~8 GB (TTS + ollama idle) |
| A2F track storage | ~15 MB / lecture |
| Docker image (NIM) | 35.9 GB (one-time) |

---

## 3. Existing instrumentation (free data sources)

| Source | What it gives |
|---|---|
| `[AUDIO START]` in backend log | played text + slide per unit |
| `[LECTURE_SYNC] corrected` | cross-client drift events |
| `[translate] rejected/repaired/strong-model rescue` | translation pipeline stats |
| `bakeStats.translationRetries` | cumulative counter (bakeStats.mjs) |
| `/api/lecture/segment_a2f*` + meta `frames/fps/durationSec` | track integrity |
| `nvidia-smi` | VRAM by process (per phase) |
| `scripts/bake_a2f.py` summary table | bake throughput |
| Whisper service (`whisper_service.py`, `WHISPER_PYTHON`) | WER transcription of baked WAVs |
| Frontend console | `[a2f] track load failed` events |

Suggested additions if needed: timestamp `[a2f] track applied` once per
message in Avatar.jsx; `bakeStats` JSON export for the report.

---

## 4. Human evaluation design (minimum viable)

- **Raters:** ≥ 5 (ideally 8–10) — class peers
- **Material:** 4 clips (seg 2 + seg 6) × 2 languages (en, ar) × 2 modes
  (a2f, spectral) = 16 clips, randomized, blind
- **Ratings:** per clip: naturalness 1–5, lip-sync accuracy 1–5,
  overall preference (forced choice)
- **Also:** 2 clips × 3 languages for TTS-only intelligibility
- **Analysis:** mean ± std per mode; paired comparison on preference

## 5. Procedure checklist

1. `bash start_all.sh`; NIM up only if re-baking.
2. Full en lecture watch-through, noting R3–R6 behaviors live.
3. Repeat segments 0–3 in ar + zh (language switch test).
4. Pull metrics from logs (table in §2.3–2.5).
5. Whisper-WER pass over 10 random WAVs across languages.
6. MOS/ABX session with raters.
7. VRAM snapshots per phase (`nvidia-smi --query-compute-apps=pid,used_memory`).

## 6. Results tables (fill during eval)

### Lipsync A/B

| lang | mode | MOS nat. | MOS sync | prefer % | offset ms |
|---|---|---|---|---|---|
| en | a2f | | | | |
| en | spectral | | | | |
| ar | a2f | | | | |
| ar | spectral | | | | |

### TTS per language

| lang | WER % | MOS nat. | speaker sim | gen ×rt |
|---|---|---|---|---|
| en | | | | |
| ar | | | | |
| zh | | | | |
| es | | | | |
| fr | | | | |
| de | | | | |

### Translation pipeline

| lang | calls | rejected % | repaired % | rescued | mean attempts |
|---|---|---|---|---|---|
| ar | | | | | |
| zh | | | | | |
| es | | | | | |
| fr | | | | | |
| de | | | | | |

### Latency

| unit | p50 | p95 | target | pass |
|---|---|---|---|---|
| baked segment start | | | <1 s | |
| dynamic utterance | | | <10 s | |
| student answer E2E | | | <15 s | |
| cold answer | | | <30 s | |

## 7. What counts as "success" for the thesis

- A2F beats spectral on MOS + preference, holds in ar/zh
- WER acceptable in all 6 languages
- Zero wrong-language audio reaching the client (validator)
- Slide/audio/lipsync aligned 100% through a full lecture
- Cross-client drift inside ±0.35 s tolerance
- All R1–R8 robustness cases pass or degrade gracefully
- Full 6-language build reproducible in < 60 min, ~19 GB peak VRAM
