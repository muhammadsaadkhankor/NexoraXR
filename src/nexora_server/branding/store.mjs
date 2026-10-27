// Branding storage: app name in app_settings, uploaded assets on disk under
// uploads/ (served by /api/branding/asset/:name). Write access is admin-only
// via /api/admin/branding; reads are public.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPool, dbAvailable } from '../db/pool.mjs';

const SERVER_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const UPLOADS = path.join(SERVER_DIR, 'uploads');

const MIME_EXT = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/svg+xml': 'svg',
  'image/webp': 'webp', 'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico',
};
const ASSETS = ['logo', 'favicon'];
const MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_NAME = 'NexoraXR';

export async function readBranding() {
  const out = { appName: DEFAULT_NAME, logoUrl: null, faviconUrl: null };
  if (!dbAvailable()) return out;
  try {
    const { rows } = await getPool().query(
      `SELECT key, value FROM app_settings WHERE key = ANY($1)`,
      [['app_name', 'logo_asset', 'favicon_asset']]);
    const m = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    if (m.app_name) out.appName = m.app_name;
    for (const kind of ASSETS) {
      const f = m[`${kind}_asset`];
      if (f && fs.existsSync(path.join(UPLOADS, f))) {
        out[`${kind}Url`] = `/api/branding/asset/${kind}`;
      }
    }
  } catch { /* settings unreadable → defaults */ }
  return out;
}

// dataUrl or null (null clears). Returns the stored filename.
export async function saveAsset(kind, dataUrl, userId) {
  if (!ASSETS.includes(kind)) throw new Error('bad asset kind');
  const pool = getPool();
  if (dataUrl === null) {
    await pool.query(
      `INSERT INTO app_settings (key, value, updated_at, updated_by)
       VALUES ($1, '', now(), $2)
       ON CONFLICT (key) DO UPDATE SET value='', updated_at=now(), updated_by=$2`,
      [`${kind}_asset`, userId]);
    return null;
  }
  const m = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(dataUrl || '');
  if (!m) throw new Error('asset must be a data:image/…;base64 URL');
  const ext = MIME_EXT[m[1].toLowerCase()];
  if (!ext) throw new Error(`unsupported image type ${m[1]}`);
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length || buf.length > MAX_BYTES) throw new Error('image must be ≤ 2 MB');

  await fsp.mkdir(UPLOADS, { recursive: true });
  const filename = `branding-${kind}.${ext}`;
  await fsp.writeFile(path.join(UPLOADS, filename), buf);
  await pool.query(
    `INSERT INTO app_settings (key, value, updated_at, updated_by)
     VALUES ($1, $3, now(), $2)
     ON CONFLICT (key) DO UPDATE SET value=$3, updated_at=now(), updated_by=$2`,
    [`${kind}_asset`, userId, filename]);
  return filename;
}

export function assetFile(kind) {
  if (!ASSETS.includes(kind)) return null;
  return dbAvailable() ? { dir: UPLOADS } : null;
}
