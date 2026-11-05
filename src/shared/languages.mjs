// Single source of truth for the supported classroom/lecture languages.
// Imported by the backend (nexora_ai routes, nexora_server protocol +
// course pipeline) AND the Vite client — keep it dependency-free ESM.
//
// Per entry:
//   code        — ISO code used everywhere (room language, cache suffix)
//   name        — English display name (LLM prompts, server labels)
//   label       — native display name (client dropdowns)
//   speechLang  — BCP-47 locale for Web Speech recognition
//   voiceSuffix — VoxCPM voice-registry suffix (`abed101_<suffix>`), null = base voice
//   durationRatio — expected audio duration vs the English segment {min,max}
//   textCheck   — 'english' | 'script' (non-Latin script audit) | 'franc:<code>'
//
// 'hi' intentionally absent — VoxCPM2 produces garbled Hindi (verified);
// re-enable only with a verified Hindi-capable voice/model.

export const LANGUAGES = [
  { code: 'en', name: 'English', label: 'English', speechLang: 'en-US',
    voiceSuffix: null, durationRatio: null, textCheck: 'english' },
  { code: 'ar', name: 'Arabic', label: 'العربية', speechLang: 'ar-SA',
    voiceSuffix: 'ar', durationRatio: { min: 0.6, max: 1.7 }, textCheck: 'script' },
  { code: 'fr', name: 'French', label: 'Français', speechLang: 'fr-FR',
    voiceSuffix: 'fr', durationRatio: { min: 0.6, max: 1.7 }, textCheck: 'franc:fra' },
  { code: 'de', name: 'German', label: 'Deutsch', speechLang: 'de-DE',
    voiceSuffix: 'de', durationRatio: { min: 0.6, max: 1.7 }, textCheck: 'franc:deu' },
  { code: 'es', name: 'Spanish', label: 'Español', speechLang: 'es-ES',
    voiceSuffix: 'es', durationRatio: { min: 0.6, max: 1.7 }, textCheck: 'franc:spa' },
  { code: 'zh', name: 'Chinese', label: '中文', speechLang: 'zh-CN',
    voiceSuffix: 'zh', durationRatio: { min: 0.3, max: 1.2 }, textCheck: 'script' },
];

export const LANGUAGE_CODES = Object.freeze(LANGUAGES.map((l) => l.code));

// Room-wide languages (includes English).
export const SUPPORTED_LANGUAGE_CODES = LANGUAGE_CODES;

// Languages translated from the canonical English script.
export const TRANSLATION_LANGUAGE_CODES = Object.freeze(
  LANGUAGES.filter((l) => l.code !== 'en').map((l) => l.code));

// { code: English name } — LLM prompts and server-side labels.
export const LANGUAGE_NAMES = Object.freeze(
  Object.fromEntries(LANGUAGES.map((l) => [l.code, l.name])));

// { code: native label } — client dropdowns.
export const LANGUAGE_LABELS = Object.freeze(
  Object.fromEntries(LANGUAGES.map((l) => [l.code, l.label])));

// { code: BCP-47 recognition locale } — client speech recognition.
export const SPEECH_RECOGNITION_LANGS = Object.freeze(
  Object.fromEntries(LANGUAGES.map((l) => [l.code, l.speechLang])));

export function getLanguage(code) {
  return LANGUAGES.find((l) => l.code === code) || null;
}

// Expected audio-duration band vs the English segment, or null for English
// itself. Falls back to the global default band when unset.
export function durationRatioBand(code, fallback = { min: 0.6, max: 1.7 }) {
  return getLanguage(code)?.durationRatio || fallback;
}
