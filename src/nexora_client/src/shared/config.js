// Base URL of the NexoraXR backend (Express + Socket.IO).
// Override via VITE_API_URL (see .env.example); falls back to local dev default.
// Same-origin by default: Vite proxies /api and /socket.io to the backend,
// so tunnelling the dev port (cloudflared → :5173) exposes the whole app —
// phone, LAN, or public link — with zero extra config. VITE_API_URL overrides.
export const API_URL = import.meta.env?.VITE_API_URL ?? '';

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

// Language support is defined ONCE for the whole app in
// src/shared/languages.mjs — imported here and re-exported in the shapes
// the client components already consume.
import {
  LANGUAGES,
  LANGUAGE_CODES,
  SPEECH_RECOGNITION_LANGS as _SPEECH,
} from '../../../shared/languages.mjs';

// Web Speech API BCP-47 recognition locales per room language.
export const SPEECH_RECOGNITION_LANGS = _SPEECH;

// Room languages offered by the classroom creation UI — same list the
// server's SUPPORTED_LANGUAGES is derived from.
export const CLASSROOM_LANGUAGES = LANGUAGES.map(({ code, label }) => ({ code, label }));
export const CLASSROOM_LANGUAGE_CODES = LANGUAGE_CODES;

// Create-classroom form validation (mirrors server-side registry checks).
export function validateClassroomDraft({ className, lectureId, language } = {}) {
  return (
    typeof className === 'string' && className.trim().length > 0 &&
    (lectureId == null || /^[A-Za-z0-9_-]{1,64}$/.test(lectureId)) &&
    (language == null || CLASSROOM_LANGUAGES.some((l) => l.code === language))
  );
}
