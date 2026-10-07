// Base URL of the NexoraXR backend (Express + Socket.IO).
// Override via VITE_API_URL (see .env.example); falls back to local dev default.
export const API_URL = import.meta.env?.VITE_API_URL || 'http://localhost:3000';

// Stable per-browser participant identity (survives socket reconnects).
const PARTICIPANT_ID_KEY = 'nexoraxr_participant_id';
export function getParticipantId() {
  let id = sessionStorage.getItem(PARTICIPANT_ID_KEY);
  if (!id) {
    id = (crypto.randomUUID?.() || `p_${Date.now()}_${Math.random().toString(16).slice(2)}`).slice(0, 64);
    sessionStorage.setItem(PARTICIPANT_ID_KEY, id);
  }
  return id;
}

// Web Speech API BCP-47 recognition locales per room language.
// 'hi' intentionally absent — Hindi is unsupported end-to-end (TTS unverified).
export const SPEECH_RECOGNITION_LANGS = {
  en: 'en-US',
  ar: 'ar-SA',
  fr: 'fr-FR',
  de: 'de-DE',
  es: 'es-ES',
  zh: 'zh-CN',
};

// Room languages offered by the classroom creation UI — mirrors the server's
// SUPPORTED_LANGUAGES (single client-side source for dropdowns).
export const CLASSROOM_LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'ar', label: 'العربية' },
  { code: 'fr', label: 'Français' },
  { code: 'de', label: 'Deutsch' },
  { code: 'es', label: 'Español' },
  { code: 'zh', label: '中文' },
];

// Create-classroom form validation (mirrors server-side registry checks).
export function validateClassroomDraft({ className, lectureId, language } = {}) {
  return (
    typeof className === 'string' && className.trim().length > 0 &&
    /^[A-Za-z0-9_-]{1,64}$/.test(lectureId || '') &&
    CLASSROOM_LANGUAGES.some((l) => l.code === language)
  );
}
