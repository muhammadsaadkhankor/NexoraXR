// Public branding endpoints (no auth — the app name/logo are shown to
// everyone, including the landing page and login screen).

import { Router } from 'express';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBranding } from './store.mjs';
import { getPool, dbAvailable } from '../db/pool.mjs';

const SERVER_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const UPLOADS = path.join(SERVER_DIR, 'uploads');
const KINDS = new Set(['logo', 'favicon']);

const router = Router();

router.get('/branding', async (_req, res) => {
  res.json(await readBranding());
});

// Serves the configured asset file. The stored filename lives in
// app_settings so only files we wrote are ever served.
router.get('/branding/asset/:kind', async (req, res) => {
  if (!KINDS.has(req.params.kind) || !dbAvailable()) return res.status(404).end();
  try {
    const { rows } = await getPool().query(
      `SELECT value FROM app_settings WHERE key=$1`, [`${req.params.kind}_asset`]);
    const file = rows[0]?.value;
    if (!file) return res.status(404).end();
    const ext = file.split('.').pop();
    const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
      svg: 'image/svg+xml', webp: 'image/webp', ico: 'image/x-icon' }[ext];
    if (!mime) return res.status(404).end();
    const buf = await fsp.readFile(path.join(UPLOADS, file)); // filename came from DB, written by us
    res.set('Content-Type', mime);
    res.set('Cache-Control', 'public, max-age=60');
    res.send(buf);
  } catch {
    res.status(404).end();
  }
});

export default router;
