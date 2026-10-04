import { API_URL } from '../../shared/config';

const API_BASE = `${API_URL}/api`;

export async function getLectures() {
  const res = await fetch(`${API_BASE}/lectures`);
  if (!res.ok) throw new Error('Failed to load lectures');
  return res.json();
}

export async function explainLecture(lectureId, voiceId) {
  const body = { lectureId };
  if (voiceId) body.voiceId = voiceId;

  const res = await fetch(`${API_BASE}/lecture/explain`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to generate explanation');
  return data;
}

export function audioUrl(path) {
  return `${API_URL}${path}`;
}
