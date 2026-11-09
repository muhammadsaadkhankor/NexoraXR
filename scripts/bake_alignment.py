#!/usr/bin/env python3
"""Bake per-segment SENTENCE alignment for lecture audio.

For every <bucket>/segment_NNN.wav + segment_NNN.txt pair in the segment
cache, transcribe with Whisper word timestamps and map the KNOWN script's
sentence boundaries onto the audio timeline:

  1. proportional position by normalized character count (robust across
     languages — tokenization differences don't matter), then
  2. SNAP each boundary to the nearest real inter-word pause — TTS pauses
     at sentence ends, so the snapped boundary is the true sentence start.

Writes <bucket>/alignment.json:

  { "model": "...", "segments": { "003": {
      "duration": 21.4, "whisperLang": "zh",
      "sentences": [{"i":0,"start":0.0,"end":4.2,"snapped":false}, ...] } } }

The server attaches `sentences` to manifest segments; the client uses them
to resume a language switch at the SAME sentence instead of replaying the
segment from scratch.
"""
import argparse
import json
import re
import sys
import wave
from pathlib import Path

import whisper

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / 'src' / 'nexora_ai' / 'lecture_cache' / 'segments'

# Same sentence split the backend's sentence-split fallback uses, plus a
# no-space variant for CJK punctuation (Chinese has no post-period space).
SENT_SPLIT = re.compile(r'(?<=[.!?。！？…؟])\s+|(?<=[。！？…])')
NON_WORD = re.compile(r'[^\w]+', re.UNICODE)
GAP_MIN = 0.10    # s — inter-word pause that may mark a sentence boundary
SNAP_SEC = 2.0    # s — search window around the proportional estimate


def clean_text(t):
    """Mirror cleanTextForTts (lectureRoutes.mjs) — the wav was synthesized
    from this cleaned text, so alignment must use the same."""
    t = re.sub(r'\*\*', '', t)
    t = re.sub(r'\[[^\]]*\]', '', t)
    t = re.sub(r'\{[^}]*\}', '', t)
    t = re.sub(r'^\s*[-*•–]\s+', '', t, flags=re.M)
    t = re.sub(r'^\s*\d+\.\s+', '', t, flags=re.M)
    return re.sub(r'\s+', ' ', t).strip()


def norm_len(s):
    return len(NON_WORD.sub('', s.lower()))


def sentences_of(text):
    cleaned = clean_text(text)
    parts = [p.strip() for p in SENT_SPLIT.split(cleaned) if p.strip()]
    return parts or ([cleaned] if cleaned else [])


def wav_duration(path):
    with wave.open(str(path), 'rb') as w:
        return w.getnframes() / w.getframerate()


def align(sent_texts, words, duration):
    """Map script sentence boundaries onto the audio timeline.

    Returns [{'i','start','end','snapped'}] — monotonic, clamped to
    [0, duration]. Falls back to an even spread when Whisper yields no
    words (degenerate audio — should not happen for baked TTS).
    """
    n = len(sent_texts)
    if n == 0:
        return []
    if not words or n == 1:
        return [{'i': i, 'start': round(duration * i / n, 3),
                 'end': round(duration * (i + 1) / n, 3), 'snapped': False}
                for i in range(n)]

    lens = [max(1, norm_len(s)) for s in sent_texts]
    total = sum(lens)
    # Cumulative normalized char counts over Whisper words.
    wcum = [0]
    for w in words:
        wcum.append(wcum[-1] + max(1, norm_len(w['word'])))
    wtot = wcum[-1]

    starts = [0.0]
    snapped = [False]
    acc = 0
    for i in range(1, n):
        acc += lens[i - 1]
        pos = acc / total * wtot  # expected char position in whisper timeline
        k = 0
        while k < len(words) - 1 and wcum[k + 1] < pos:
            k += 1
        est = words[k]['start']
        # Snap to the nearest inter-word gap inside the window.
        best, best_d = est, SNAP_SEC + 1
        for j in range(len(words) - 1):
            g0, g1 = words[j]['end'], words[j + 1]['start']
            if g1 - g0 >= GAP_MIN and est - SNAP_SEC <= g0 and g1 <= est + SNAP_SEC:
                d = abs(g1 - est)
                if d < best_d:
                    best, best_d = g1, d
        snapped.append(abs(best - est) > 1e-3)
        starts.append(best)

    out = []
    for i in range(n):
        start = max(0.0, float(starts[i]))
        end = min(float(duration), float(starts[i + 1])) if i + 1 < n else float(duration)
        out.append({'i': i, 'start': round(start, 3),
                    'end': round(end, 3), 'snapped': bool(snapped[i])})
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--lecture', default='multimedia_L',
                    help='bucket name prefix or comma-separated bucket list')
    ap.add_argument('--model', default='small')
    ap.add_argument('--force', action='store_true')
    args = ap.parse_args()

    names = args.lecture.split(',')
    buckets = sorted(d for d in CACHE.iterdir() if d.is_dir()
                     and any(d.name == n or d.name.startswith(n) for n in names))
    if not buckets:
        sys.exit(f'no segment buckets matching {args.lecture!r} under {CACHE}')

    print(f'[align] loading whisper {args.model}...', flush=True)
    model = whisper.load_model(args.model)
    dev = next(model.parameters()).device.type
    print(f'[align] model on {dev}; {len(buckets)} buckets', flush=True)

    done = skipped = failed = 0
    for bucket in buckets:
        lang = bucket.name.split('__')[1] if '__' in bucket.name else 'en'
        out_path = bucket / 'alignment.json'
        doc = {'model': args.model, 'segments': {}}
        if out_path.exists() and not args.force:
            try:
                doc = json.loads(out_path.read_text())
            except Exception:
                pass
        dirty = False
        for wav in sorted(bucket.glob('segment_*.wav')):
            idx = wav.stem.rsplit('_', 1)[1]
            if idx in doc['segments'] and not args.force:
                skipped += 1
                continue
            txt_path = wav.with_suffix('.txt')
            if not txt_path.exists():
                print(f'[align] {bucket.name}/{idx}: no .txt — skipped')
                failed += 1
                continue
            try:
                res = model.transcribe(str(wav), language=lang,
                                       word_timestamps=True, verbose=False)
                words = [{'word': w['word'], 'start': w['start'], 'end': w['end']}
                         for seg in res['segments'] for w in (seg.get('words') or [])]
                sents = sentences_of(txt_path.read_text())
                dur = wav_duration(wav)
                doc['segments'][idx] = {
                    'duration': round(dur, 3),
                    'whisperLang': res.get('language'),
                    'sentences': align(sents, words, dur),
                }
                done += 1
                dirty = True
                if done % 40 == 0:
                    print(f'[align] {done} segments… ({bucket.name})', flush=True)
            except Exception as e:
                print(f'[align] {bucket.name}/{idx} FAIL: {e}')
                failed += 1
        if dirty:
            out_path.write_text(json.dumps(doc, ensure_ascii=False, indent=1))
            print(f'[align] {bucket.name}: wrote alignment.json '
                  f'({len(doc["segments"])} segs)', flush=True)
    print(f'[align] DONE — {done} aligned, {skipped} cached, {failed} failed')


if __name__ == '__main__':
    main()
