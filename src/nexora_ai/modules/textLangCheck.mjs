// Language-content check for machine-translated lecture text.
// Cheap heuristics only — script coverage for zh/ar, franc-min (restricted
// to the supported latin-script candidates) for fr/de/es. English technical
// terms inside a sentence are fine; the check targets the majority of text.

import { francAll } from 'franc-min';

const LETTER_RE = /\p{L}/gu;
const CJK_RE = /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}/u;
const ARABIC_RE = /\p{Script=Arabic}/u;
const LATIN_FRANC = { en: 'eng', fr: 'fra', de: 'deu', es: 'spa' };
const FRANC_ONLY = ['eng', 'fra', 'deu', 'spa'];
const SHORT_TEXT = 40; // below this franc is unreliable — skip detection
const SCRIPT_THRESHOLD = 0.5;
const ENG_MAX = 0.9; // latin check: reject when 'eng' scores this high

function scriptFraction(text, re) {
  const letters = text.match(LETTER_RE) || [];
  if (!letters.length) return 0;
  let hits = 0;
  for (const ch of letters) if (re.test(ch)) hits++;
  return hits / letters.length;
}

// Returns { ok: true } or { ok: false, reason } — never throws.
export function validateTranslation(text, lang) {
  const t = (text || '').trim();
  if (!t) return { ok: false, reason: 'empty' };
  if (lang === 'en') return { ok: true };

  if (lang === 'zh') {
    const f = scriptFraction(t, CJK_RE);
    return f >= SCRIPT_THRESHOLD
      ? { ok: true }
      : { ok: false, reason: `cjk-fraction ${f.toFixed(2)} < ${SCRIPT_THRESHOLD}` };
  }
  if (lang === 'ar') {
    const f = scriptFraction(t, ARABIC_RE);
    return f >= SCRIPT_THRESHOLD
      ? { ok: true }
      : { ok: false, reason: `arabic-fraction ${f.toFixed(2)} < ${SCRIPT_THRESHOLD}` };
  }
  if (lang === 'fr' || lang === 'de' || lang === 'es') {
    // Very short text: franc is unreliable; the caller's
    // not-identical-to-English rule is the only signal.
    if (t.length < SHORT_TEXT) return { ok: true };
    // Top candidate must be the target language AND English must not be a
    // plausible alternative — franc-min's trigrams often rank technical
    // English barely below 'fra', so a bare top-match is not enough.
    const scores = Object.fromEntries(francAll(t, { only: FRANC_ONLY }));
    const detected = francAll(t, { only: FRANC_ONLY })[0]?.[0];
    if (!detected || detected === 'und') return { ok: false, reason: 'undetermined-language' };
    if (detected !== LATIN_FRANC[lang]) {
      return { ok: false, reason: `franc detected '${detected}' expected '${LATIN_FRANC[lang]}'` };
    }
    if ((scores.eng ?? 0) >= ENG_MAX) {
      return { ok: false, reason: `english-plausible(eng=${scores.eng?.toFixed(2)})` };
    }
    return { ok: true };
  }
  return { ok: false, reason: `unsupported language '${lang}'` };
}
