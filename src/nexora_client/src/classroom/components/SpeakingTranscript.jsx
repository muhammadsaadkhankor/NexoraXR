import { useEffect, useMemo, useRef, useState } from 'react';

// ~words per second used until the audio element reports a real duration
const FALLBACK_WPS = 2.6;

export function SpeakingTranscript({ text, audioRef, lipsync }) {
  const endRef = useRef(null);
  const playedSecRef = useRef(0);
  const lastNowRef = useRef(null);
  const [visibleCount, setVisibleCount] = useState(0);
  const [finished, setFinished] = useState(false);

  // Parse raw text into lines; markdown headings (###, ####) become their own line.
  const lines = useMemo(() => {
    const out = [];
    (text || '').split('\n').forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      const heading = /^#{1,4}\s+/.test(trimmed);
      const cleaned = trimmed
        .replace(/^#{1,4}\s+/, '')
        .replace(/\*\*/g, '')
        .replace(/\[[^\]]*\]/g, '')
        .replace(/^\s*[-*•–]\s+/, '')
        .replace(/^\s*\d+\.\s+/, '')
        .trim();
      if (!cleaned) return;
      out.push({ heading, words: cleaned.split(/\s+/).filter(Boolean) });
    });
    return out;
  }, [text]);

  // Flattened words with cumulative character counts for audio-sync weighting.
  const words = useMemo(() => {
    let cum = 0;
    return lines.flatMap((line) =>
      line.words.map((word) => {
        cum += word.length;
        return { cum };
      })
    );
  }, [lines]);
  const lineStart = useMemo(() => {
    const arr = [];
    let acc = 0;
    lines.forEach((l) => {
      arr.push(acc);
      acc += l.words.length;
    });
    return arr;
  }, [lines]);

  const totalChars = words.length ? words[words.length - 1].cum : 1;

  // Per-word timestamps don't exist in the artifacts — mouth-cue payloads
  // only carry phoneme timings + total duration. Best available clock is
  // the audio element itself; the baked lipsync metadata duration is a
  // closer second than the words-per-second guess.
  const lipsyncDur =
    lipsync?.metadata?.duration || lipsync?.duration || null;

  useEffect(() => {
    setVisibleCount(0);
    setFinished(false);
    playedSecRef.current = 0;
    lastNowRef.current = null;

    let raf;
    const tick = (now) => {
      const audio = audioRef?.current;
      let frac = 0;
      const duration = audio && Number.isFinite(audio.duration) ? audio.duration : 0;
      if (audio && duration > 0) {
        // progress synced to the real TTS audio; pauses/resumes naturally
        frac = audio.ended ? 1 : audio.currentTime / duration;
      } else if (audio && lipsyncDur && audio.readyState >= 1) {
        // Duration known from baked cues before the element reports it —
        // still audio-clock driven; pauses freeze automatically.
        frac = audio.ended ? 1 : Math.min(1, audio.currentTime / lipsyncDur);
      } else if (!audio || audio.readyState >= 2) {
        // Duration not known yet but audio data exists — estimate by elapsed
        // time. While the element is still fetching (readyState < 2) hold at
        // 0 so the transcript never runs ahead of the voice.
        if (lastNowRef.current != null && (!audio || !audio.paused)) {
          playedSecRef.current += (now - lastNowRef.current) / 1000;
        }
        frac = Math.min(1, (playedSecRef.current * FALLBACK_WPS) / Math.max(words.length, 1));
      }
      lastNowRef.current = now;

      const target = frac * totalChars;
      let count = 0;
      while (count < words.length && words[count].cum <= target) count += 1;
      setVisibleCount((v) => (count > v ? count : v));
      setFinished(frac >= 1);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [text, words, totalChars, audioRef, lipsyncDur]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'nearest' });
  }, [visibleCount]);

  return (
    // Inline so history + live words read as ONE continuous paragraph.
    <span className="speaking-transcript">
      <style>{`
        .speaking-transcript .st-word { opacity: 0; animation: stFadeIn .18s ease-out forwards; }
        .speaking-transcript .st-heading { display: block; font-weight: 700; color: #67e8f9; margin: .35rem 0 .1rem; }
        .speaking-transcript .st-cursor { display: inline-block; width: .55em; margin-left: 2px; color: #22d3ee; animation: stBlink 1s steps(2, start) infinite; }
        @keyframes stFadeIn { to { opacity: 1; } }
        @keyframes stBlink { to { visibility: hidden; } }
      `}</style>

      {lines.map((line, li) => {
        const start = lineStart[li];
        return (
          <span key={li} className={line.heading ? 'st-heading' : undefined}>
            {line.words.map((w, wi) =>
              start + wi < visibleCount ? (
                <span key={wi} className="st-word">
                  {w}{' '}
                </span>
              ) : null
            )}
          </span>
        );
      })}

      {!finished && <span className="st-cursor">▌</span>}
      <span ref={endRef} />
    </span>
  );
}
