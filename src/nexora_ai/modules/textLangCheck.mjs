// Language-content check for machine-translated lecture text.
// Cheap heuristics only — script coverage for zh/ar, franc-min top-match plus
// a stopword/diacritic signal for fr/de/es. English technical terms inside a
// sentence are fine; the check targets the majority of text.

import { francAll } from 'franc-min';

const LETTER_RE = /\p{L}/gu;
const CJK_RE = /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}/u;
const ARABIC_RE = /\p{Script=Arabic}/u;
const LATIN_FRANC = { en: 'eng', fr: 'fra', de: 'deu', es: 'spa' };
const FRANC_ONLY = ['eng', 'fra', 'deu', 'spa'];
const SHORT_TEXT = 40; // below this franc is unreliable — skip detection
const SCRIPT_THRESHOLD = 0.5;

// Function-word + diacritic signal. francAll scores are trigram similarities,
// not probabilities: with only 4 Latin candidates, 'eng' routinely exceeds 0.9
// on fluent French/German/Spanish prose, so it cannot be an absolute gate.
// The secondary signal counts real function words; an English stopword list is
// kept free of tokens that are also legitimate target-language words
// ('a', 'in', 'on', 'es', 'son', ...).
const STOPWORDS = {
  en: new Set('the,and,is,are,was,were,that,this,which,will,would,have,has,with,for,from,when,there,what,them,than,each,not,all,who,how,into,can,because,through,about,these,those,they,their,should,could'.split(',')),
  fr: new Set('le,la,les,de,des,et,est,une,dans,pour,que,qui,nous,vous,aux,avec,sur,pas,par,son,ses,au,ce,cette,comme,mais,où,leur,leurs,bien,aussi,très,ont,sans,entre,plus,en,il,elle,ils,elles,du,ne,se,sa,ces,dont'.split(',')),
  de: new Set('der,die,das,und,ist,ein,eine,den,von,mit,auf,für,als,an,dem,es,ich,nicht,sie,sich,wir,werden,dass,auch,kann,nur,wie,oder,aber,über,beim,des,zu,in,im,aus,bei,nach,vor,zum,zur,uns'.split(',')),
  es: new Set('el,la,los,las,de,y,es,un,una,en,que,por,con,para,se,su,al,como,más,pero,sus,muy,sin,sobre,también,esto,este,esta,donde,cuando,del,lo,nos,les,ya'.split(',')),
};
const DIACRITICS = {
  fr: /[àâäçéèêëîïôöùûüœ]/g,
  de: /[äöüß]/g,
  es: /[áéíóúüñ¿¡]/g,
};

function langSignal(text, lang) {
  const words = text.toLowerCase().split(/[^\p{L}\p{M}]+/u).filter(Boolean);
  let n = 0;
  const sw = STOPWORDS[lang];
  for (const w of words) if (sw.has(w)) n++;
  const diac = text.match(DIACRITICS[lang]);
  // Diacritics are unambiguous target-script markers — count double.
  return n + (diac ? diac.length * 2 : 0);
}

// Leaked instruction/meta text — the translator model sometimes narrates its
// own task ("below is the translation", "继续您的翻译"). Strong CJK phrases are
// never legitimate narration. Weak markers are legitimized when the English
// source itself talks about translating/continuing/examples.
const META_STRONG = [
  '以下是', '翻译内容', '继续翻译', '您的翻译', '示例结束', '这是阿拉伯语', '这段话',
  'below is the translation', 'here is the translation', 'the translation:',
];
// [marker-in-output, substring-that-legitimizes-it-in-source]
const META_WEAK = [
  ['翻译', 'translat'],
  ['以下', 'below'], ['以下', 'following'],
  ['继续', 'continu'],
  ['示例', 'example'],
  ['here is', 'here'],
  ['below is', 'below'],
  ['the following', 'following'],
  ['output only', 'output'],
  ['translation', 'translat'],
  ['translated', 'translat'],
];

function leakedMetaReason(text, source) {
  const lower = text.toLowerCase();
  const src = (source || '').toLowerCase();
  for (const m of META_STRONG) {
    if (lower.includes(m.toLowerCase())) return m;
  }
  for (const [marker, legit] of META_WEAK) {
    const needle = marker.toLowerCase();
    if (!lower.includes(needle)) continue;
    if (src.includes(legit)) continue; // source mentions it — fair vocabulary
    return marker;
  }
  return null;
}

function scriptFraction(text, re) {
  const letters = text.match(LETTER_RE) || [];
  if (!letters.length) return 0;
  let hits = 0;
  for (const ch of letters) if (re.test(ch)) hits++;
  return hits / letters.length;
}

// Per-character script audit. The translator model emits stray Cyrillic,
// Thai, and replacement/box glyphs inside otherwise-valid Arabic — majority
// script fractions don't catch a 2-character leak, so every script other
// than the target's (plus Latin, which is governed separately) is a reject.
const SCRIPT_TESTS = [
  ['latin', /\p{Script=Latin}/u],
  ['cjk', /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}/u],
  ['arabic', /\p{Script=Arabic}/u],
  ['cyrillic', /\p{Script=Cyrillic}/u],
  ['thai', /\p{Script=Thai}/u],
  ['hangul', /\p{Script=Hangul}/u],
  ['devanagari', /\p{Script=Devanagari}/u],
  ['greek', /\p{Script=Greek}/u],
  ['hebrew', /\p{Script=Hebrew}/u],
];
const BAD_GLYPH = /[�-]/u;
const LATIN_WORD_RE = /[\p{Script=Latin}]{2,}/gu;
// Expected scripts per target. Latin words are handled by the foreign-word
// check (must appear in the source or be an ALL-CAPS technical acronym).
const ALLOWED_SCRIPTS = {
  ar: new Set(['arabic', 'latin']),
  zh: new Set(['cjk', 'latin']),
  fr: new Set(['latin']),
  de: new Set(['latin']),
  es: new Set(['latin']),
};

function scriptAuditReason(text, lang) {
  if (BAD_GLYPH.test(text)) return 'invalid-glyph';
  const letters = text.match(LETTER_RE) || [];
  for (const ch of letters) {
    const script = SCRIPT_TESTS.find(([, re]) => re.test(ch))?.[0] || 'other';
    if (!ALLOWED_SCRIPTS[lang].has(script)) return `unexpected-script:${script}`;
  }
  return null;
}

// Word-level source vocabulary: lowercase latin words of the source. Output
// Latin words must appear in it (technical terms are kept in brackets) or be
// ALL-CAPS acronyms like ML, AI, GPU.
function sourceWordSet(source) {
  return new Set(((source || '').toLowerCase().match(LATIN_WORD_RE) || []));
}
const isAllowedLatin = (w, srcWords) =>
  srcWords.has(w.toLowerCase()) || (/^[A-Z0-9]{2,5}$/.test(w) && w.length <= 5);

// Signature diacritics per latin-script language — chars that NEVER belong
// to the target (e.g. ñ inside German, ß inside Spanish). Plain ASCII
// foreign words are caught by the stopword-of-other-language test below.
const FOREIGN_SIG = {
  fr: /[ñ¿¡áíóúßäöü]/i,
  de: /[ñ¿¡áíóúàèêîûœç]/i,   // é kept — 'Café' is a legitimate German loanword
  es: /[ßäöàèêîûœç]/i,       // ü kept — 'vergüenza' is legitimate Spanish
};
function foreignWordReason(text, lang, srcWords) {
  const words = text.match(LATIN_WORD_RE) || [];
  if (lang === 'ar' || lang === 'zh') {
    const w = words.find((w) => !isAllowedLatin(w, srcWords));
    return w ? `foreign-word:${w}` : null;
  }
  const sig = FOREIGN_SIG[lang];
  for (const w of words) {
    if (sig.test(w) && !isAllowedLatin(w, srcWords)) return `foreign-word:${w}`;
    // A function word of a DIFFERENT supported language inside latin output
    // (not present in source, not a stopword of the target) is language
    // bleed, e.g. Spanish 'para' inside German.
    if (w.length >= 4 && !isAllowedLatin(w, srcWords)) {
      const lw = w.toLowerCase();
      for (const [other, sw] of Object.entries(STOPWORDS)) {
        if (other !== lang && sw.has(lw) && !STOPWORDS[lang].has(lw)) {
          return `foreign-word:${w}`;
        }
      }
    }
  }
  return null;
}

// Returns { ok: true } or { ok: false, reason } — never throws.
// ctx.source is the English source text: meta words are only rejected when
// they are absent from it (a lecture about translation can say "translation").
export function validateTranslation(text, lang, ctx = {}) {
  const t = (text || '').trim();
  if (!t) return { ok: false, reason: 'empty' };
  if (lang === 'en') return { ok: true };

  // Full script audit: every character's script must belong to the target —
  // a single Cyrillic/Thai/CJK letter inside Arabic is a reject, plus
  // replacement/box glyphs (U+FFFD, private use). Latin words are allowed
  // only when they appear in the English source (kept technical terms) or
  // are short ALL-CAPS acronyms.
  const scriptBad = scriptAuditReason(t, lang);
  if (scriptBad) return { ok: false, reason: scriptBad };

  const srcWords = sourceWordSet(ctx.source);
  const wordBad = foreignWordReason(t, lang, srcWords);
  if (wordBad) return { ok: false, reason: wordBad };

  const meta = leakedMetaReason(t, ctx.source);
  if (meta) return { ok: false, reason: `leaked-meta:${meta}` };

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
    const scores = Object.fromEntries(francAll(t, { only: FRANC_ONLY }));
    const detected = francAll(t, { only: FRANC_ONLY })[0]?.[0];
    if (!detected || detected === 'und') return { ok: false, reason: 'undetermined-language' };
    if (detected !== LATIN_FRANC[lang]) {
      return { ok: false, reason: `franc detected '${detected}' expected '${LATIN_FRANC[lang]}'` };
    }
    // Second signal (tiebreaker when franc is close, e.g. fra:1.0 / eng:0.91):
    // target stopwords + diacritics must clearly outnumber English stopwords.
    const sigT = langSignal(t, lang);
    const sigE = langSignal(t, 'en');
    if (sigT <= sigE) {
      return { ok: false, reason: `weak-${lang}-signal(target=${sigT},en=${sigE})` };
    }
    return { ok: true };
  }
  return { ok: false, reason: `unsupported language '${lang}'` };
}
