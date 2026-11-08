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
  de: new Set('der,die,das,und,ist,ein,eine,den,von,mit,auf,für,als,an,dem,es,ich,nicht,sie,sich,wir,werden,dass,auch,kann,nur,wie,oder,aber,über,beim,des,zu,in,im,aus,bei,nach,vor,zum,zur,uns,was,will,so,am,um,doch,dann,mehr,sehr,jetzt,nun,dies,diese,dieser,dieses,vom,bis,durch,gegen,ohne,wenn,weil,warum'.split(',')),
  es: new Set('el,la,los,las,de,y,es,un,una,en,que,por,con,para,se,su,al,como,más,pero,sus,muy,sin,sobre,también,esto,este,esta,donde,cuando,del,lo,nos,les,ya,entre,hasta,desde,hacia,según,tras,otros,otras,todo,toda,todos,todas,cada,parte,dentro,fuera,ante,bajo,par,sur,son'.split(',')),
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
// own task ("below is the translation", "继续翻译"). Only REAL meta phrases
// block: single vocabulary words like 以下 (below/following), 继续 (continue),
// 示例 (example) or 翻译 (translation) are normal narration and must pass.
const META_PHRASES = [
  // Chinese task-narration phrases
  '以下是翻译', '以下为翻译', '以下是译文', '翻译如下', '译文如下',
  '翻译内容', '继续翻译', '您的翻译', '你的翻译', '翻译：', '译文：',
  '示例结束', '这是阿拉伯语', '这段话的翻译', '翻译这段话',
  // English task-narration phrases
  'below is the translation', 'here is the translation', 'the translation:',
  'translated text:', 'translation of the source', 'output only',
];

function leakedMetaReason(text) {
  const lower = text.toLowerCase();
  for (const m of META_PHRASES) {
    if (lower.includes(m.toLowerCase())) return m;
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
// Latin words must appear in it (technical terms are kept in brackets), be
// ALL-CAPS acronyms like ML, AI, GPU, or be a well-known technical term or
// product name that translators legitimately keep in Latin script even when
// the English source phrases it differently (e.g. "ML" → "machine learning").
const TECH_LATIN = new Set((
  'machine,learning,deep,neural,network,networks,data,dataset,datasets,database,' +
  'databases,model,models,algorithm,algorithms,computer,computers,software,' +
  'hardware,internet,web,email,app,apps,application,smartphone,smartphones,' +
  'digital,online,offline,cloud,server,servers,token,tokens,prompt,prompts,' +
  'robot,robots,robotics,sensor,sensors,image,images,video,audio,text,chatbot,' +
  'chatbots,voice,assistant,assistants,gradient,regression,classification,' +
  'clustering,supervised,unsupervised,reinforcement,transformer,transformers,' +
  'training,inference,embedding,embeddings,vector,vectors,matrix,parameter,' +
  'parameters,hyperparameter,benchmark,framework,laptop,smart,bigdata,' +
  'big,science,computing,series,time,load,prediction,forecast,forecasting,' +
  'energy,demand,electricity,power,grid,signal,signals,wave,waves,' +
  'ai,ml,nlp,llm,llms,gpu,cpu,api,ui,ux,ar,vr,xr,iot,tts,asr,ocr,sql,json,' +
  'csv,html,http,https,url,fps,led,oled,lcd,usb,ssd,ram,rom,' +
  'python,java,javascript,typescript,matlab,tensorflow,pytorch,keras,sklearn,' +
  'scikit,numpy,pandas,excel,windows,linux,macos,android,iphone,wifi,' +
  'bluetooth,gps,siri,alexa,cortana,google,amazon,apple,microsoft,openai,' +
  'chatgpt,gpt,facebook,instagram,youtube,tiktok,whatsapp,tesla,autopilot'
).split(','));
function sourceWordSet(source) {
  return new Set(((source || '').toLowerCase().match(LATIN_WORD_RE) || []));
}
const isAllowedLatin = (w, srcWords) =>
  srcWords.has(w.toLowerCase()) || TECH_LATIN.has(w.toLowerCase()) ||
  (/^[A-Z0-9]{2,5}$/.test(w) && w.length <= 5);

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

// --- Symbol repair -------------------------------------------------------
// Models leak Greek letters and math symbols into translations (α in French
// output, λ in Arabic). The script audit rejects them — but TTS needs
// spelled-out words anyway, so repairing beats rejecting. Applied BEFORE
// validation at every translate call site.
const SYMBOL_WORDS = {
  en: { 'α':'alpha','β':'beta','γ':'gamma','δ':'delta','ε':'epsilon','ζ':'zeta','η':'eta','θ':'theta','ι':'iota','κ':'kappa','λ':'lambda','μ':'mu','ν':'nu','ξ':'xi','π':'pi','ρ':'rho','σ':'sigma','τ':'tau','υ':'upsilon','φ':'phi','χ':'chi','ψ':'psi','ω':'omega','Γ':'Gamma','Δ':'Delta','Θ':'Theta','Λ':'Lambda','Π':'Pi','Σ':'Sigma','Φ':'Phi','Ω':'Omega',
    '∑':'sum','∏':'product','×':'times','÷':'divided by','≤':'less than or equal to','≥':'greater than or equal to','≈':'approximately','≠':'not equal to','±':'plus or minus','²':'squared','³':'cubed','√':'square root of','%':'percent','∞':'infinity','°':' degrees','∈':'in','→':'to','−':'-' },
  fr: { 'α':'alpha','β':'bêta','γ':'gamma','δ':'delta','ε':'epsilon','ζ':'zêta','η':'êta','θ':'thêta','ι':'iota','κ':'kappa','λ':'lambda','μ':'mu','ν':'nu','ξ':'xi','π':'pi','ρ':'rhô','σ':'sigma','τ':'tau','υ':'upsilon','φ':'phi','χ':'chi','ψ':'psi','ω':'oméga','Γ':'Gamma','Δ':'Delta','Θ':'Thêta','Λ':'Lambda','Π':'Pi','Σ':'Sigma','Φ':'Phi','Ω':'Oméga',
    '∑':'somme','∏':'produit','×':'fois','÷':'divisé par','≤':'inférieur ou égal à','≥':'supérieur ou égal à','≈':'environ','≠':'différent de','±':'plus ou moins','²':'au carré','³':'au cube','√':'racine carrée de','%':'pour cent','∞':"l'infini",'°':' degrés','∈':'dans','→':'vers','−':'-' },
  de: { 'α':'Alpha','β':'Beta','γ':'Gamma','δ':'Delta','ε':'Epsilon','ζ':'Zeta','η':'Eta','θ':'Theta','ι':'Iota','κ':'Kappa','λ':'Lambda','μ':'My','ν':'Ny','ξ':'Xi','π':'Pi','ρ':'Rho','σ':'Sigma','τ':'Tau','υ':'Ypsilon','φ':'Phi','χ':'Chi','ψ':'Psi','ω':'Omega','Γ':'Gamma','Δ':'Delta','Θ':'Theta','Λ':'Lambda','Π':'Pi','Σ':'Sigma','Φ':'Phi','Ω':'Omega',
    '∑':'Summe','∏':'Produkt','×':'mal','÷':'geteilt durch','≤':'kleiner oder gleich','≥':'größer oder gleich','≈':'ungefähr','≠':'ungleich','±':'plus minus','²':'quadrat','³':'hoch drei','√':'Wurzel aus','%':'Prozent','∞':'unendlich','°':' Grad','∈':'in','→':'nach','−':'-' },
  es: { 'α':'alfa','β':'beta','γ':'gamma','δ':'delta','ε':'épsilon','ζ':'zeta','η':'eta','θ':'theta','ι':'iota','κ':'kappa','λ':'lambda','μ':'mu','ν':'nu','ξ':'xi','π':'pi','ρ':'rho','σ':'sigma','τ':'tau','υ':'ípsilon','φ':'phi','χ':'chi','ψ':'psi','ω':'omega','Γ':'Gamma','Δ':'Delta','Θ':'Theta','Λ':'Lambda','Π':'Pi','Σ':'Sigma','Φ':'Phi','Ω':'Omega',
    '∑':'suma','∏':'producto','×':'por','÷':'entre','≤':'menor o igual que','≥':'mayor o igual que','≈':'aproximadamente','≠':'distinto de','±':'más o menos','²':'al cuadrado','³':'al cubo','√':'raíz cuadrada de','%':'por ciento','∞':'infinito','°':' grados','∈':'en','→':'a','−':'-' },
  ar: { 'α':'ألفا','β':'بيتا','γ':'جاما','δ':'دلتا','ε':'إبسيلون','ζ':'زيتا','η':'إيتا','θ':'ثيتا','ι':'يوتا','κ':'كابا','λ':'لامدا','μ':'ميو','ν':'نيو','ξ':'كسي','π':'باي','ρ':'رو','σ':'سيجما','τ':'تاو','υ':'أبسيلون','φ':'فاي','χ':'كاي','ψ':'بسي','ω':'أوميغا','Γ':'جاما','Δ':'دلتا','Θ':'ثيتا','Λ':'لامدا','Π':'باي','Σ':'سيجما','Φ':'فاي','Ω':'أوميغا',
    '∑':'مجموع','∏':'جداء','×':'ضرب','÷':'مقسوما على','≤':'أصغر من أو يساوي','≥':'أكبر من أو يساوي','≈':'تقريبا','≠':'لا يساوي','±':'زائد أو ناقص','²':'تربيع','³':'تكعيب','√':'الجذر التربيعي لـ','%':'في المئة','∞':'اللانهاية','°':' درجة','∈':'ينتمي إلى','→':'إلى','−':'-' },
  zh: { 'α':'阿尔法','β':'贝塔','γ':'伽马','δ':'德尔塔','ε':'伊普西龙','ζ':'泽塔','η':'伊塔','θ':'西塔','ι':'约塔','κ':'卡帕','λ':'兰姆达','μ':'缪','ν':'纽','ξ':'克西','π':'派','ρ':'柔','σ':'西格玛','τ':'陶','υ':'宇普西龙','φ':'斐','χ':'凯','ψ':'普赛','ω':'欧米伽','Γ':'伽马','Δ':'德尔塔','Θ':'西塔','Λ':'兰姆达','Π':'派','Σ':'西格玛','Φ':'斐','Ω':'欧米伽',
    '∑':'求和','∏':'乘积','×':'乘以','÷':'除以','≤':'小于等于','≥':'大于等于','≈':'约等于','≠':'不等于','±':'加减','²':'平方','³':'立方','√':'平方根','%':'百分之','∞':'无穷大','°':'度','∈':'属于','→':'到','−':'-' },
};

// Replace Greek/math symbols with spelled-out target-language words.
// Returns { text, repaired: string[] } — repaired lists symbols that changed,
// for logging. Symbols absent from the map pass through untouched.
export function repairForeignSymbols(text, lang) {
  const map = SYMBOL_WORDS[lang] || SYMBOL_WORDS.en;
  const repaired = new Set();
  const out = (text || '').replace(/[α-ωΑ-Ω∑∏×÷≤≥≈≠±²³√%∞°∈→\u2212]/gu, (ch) => {
    if (!(ch in map)) return ch;
    repaired.add(ch);
    return ' ' + map[ch] + ' ';
  });
  return { text: out.replace(/ {2,}/g, ' '), repaired: [...repaired] };
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

  const meta = leakedMetaReason(t);
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
