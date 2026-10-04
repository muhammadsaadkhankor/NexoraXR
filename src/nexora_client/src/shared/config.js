// Base URL of the NexoraXR backend (Express + Socket.IO).
// Override via VITE_API_URL (see .env.example); falls back to local dev default.
export const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';
