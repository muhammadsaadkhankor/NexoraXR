// Branding: public app identity fetched once per page load.
import { API_URL } from './config';

export const DEFAULT_BRAND_MARK = '/wuflux-mark.svg';

let cached = null;

export function getBranding() {
  if (!cached) {
    cached = fetch(`${API_URL}/api/branding`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
      .then((b) => {
        const branding = b || { appName: 'WuFlux', logoUrl: null, faviconUrl: null };
        applyBranding(branding);
        return branding;
      });
  }
  return cached;
}

export function applyBranding(b) {
  if (!b) return;
  if (b.appName) document.title = b.appName;
  const icon = b.faviconUrl ? `${API_URL}${b.faviconUrl}` : b.logoUrl ? `${API_URL}${b.logoUrl}` : DEFAULT_BRAND_MARK;
  let link = document.querySelector("link[rel~='icon']");
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  link.removeAttribute('type');
  link.href = icon;
}

export const saveBranding = (patch) =>
  fetch(`${API_URL}/api/admin/branding`, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  }).then(async (r) => ({ ok: r.ok, data: await r.json().catch(() => ({})) }));
