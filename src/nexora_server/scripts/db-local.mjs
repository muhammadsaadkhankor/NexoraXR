// npm run db:local — provision a standalone local PostgreSQL WITHOUT Docker
// or a system package install, using pg-embedded binaries.
//
// First run downloads PostgreSQL (~100 MB) into the pg-embedded cache.
// The instance runs as a detached daemon with data in .pgdata/; DATABASE_URL
// is written into src/nexora_server/.env, then migrations are applied.
// Stop it with: npm run db:local:stop

import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { DATA_DIR, MARKER, PID_FILE, LOCAL_URL, PORT, SERVER_DIR } from './db-local.shared.mjs';

function portOpen(ms = 1000) {
  return new Promise((res) => {
    const s = net.connect({ host: '127.0.0.1', port: PORT }, () => { s.destroy(); res(true); });
    s.on('error', () => res(false));
    setTimeout(() => { s.destroy(); res(false); }, ms);
  });
}

const envPath = path.join(SERVER_DIR, '.env');
const daemon = path.join(SERVER_DIR, 'scripts', 'db-local-daemon.mjs');

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function daemonRunning() {
  try {
    const pid = Number(fs.readFileSync(PID_FILE, 'utf8'));
    return pid && alive(pid);
  } catch { return false; }
}

function writeEnv() {
  // Update or append DATABASE_URL — never touch other keys.
  let text = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  const line = `DATABASE_URL=${LOCAL_URL}`;
  if (/^DATABASE_URL=/m.test(text)) {
    if (text.match(/^DATABASE_URL=(.*)$/m)?.[1].trim() !== LOCAL_URL) {
      console.log('[db:local] updating DATABASE_URL in src/nexora_server/.env');
      text = text.replace(/^DATABASE_URL=.*$/m, line);
    }
  } else {
    console.log('[db:local] writing DATABASE_URL to src/nexora_server/.env');
    text += (text && !text.endsWith('\n') ? '\n' : '') + line + '\n';
  }
  // Dev defaults for passwordless login — only ADDED when absent, never
  // overwritten (a developer may have configured real delivery).
  const ensureKey = (key, value, why) => {
    if (!new RegExp(`^${key}=`, 'm').test(text)) {
      console.log(`[db:local] writing ${key} to src/nexora_server/.env (${why})`);
      text += (text.endsWith('\n') ? '' : '\n') + `${key}=${value}\n`;
    }
  };
  ensureKey('AUTH_DELIVERY_MODE', 'console', 'prints magic links to the backend terminal');
  ensureKey('PUBLIC_BASE_URL', 'http://localhost:5173', 'magic links land on the vite dev origin so the session cookie is same-site');
  fs.writeFileSync(envPath, text);
}

// --- already running? ------------------------------------------------------

const markerUrl = fs.existsSync(MARKER) ? fs.readFileSync(MARKER, 'utf8').trim() : '';
if (daemonRunning() && markerUrl === LOCAL_URL) {
  console.log('[db:local] embedded PostgreSQL already running');
  writeEnv();
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync(process.execPath, [path.join(SERVER_DIR, 'scripts', 'db-setup.mjs')], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}

// Stale state: a dead daemon's marker, or a daemon bound to a different port.
if (daemonRunning() && markerUrl !== LOCAL_URL) {
  const pid = Number(fs.readFileSync(PID_FILE, 'utf8'));
  try { process.kill(pid, 'SIGTERM'); } catch {}
  await new Promise((r) => setTimeout(r, 1000));
}
if (!daemonRunning() || markerUrl !== LOCAL_URL) {
  for (const f of [MARKER, PID_FILE]) { try { fs.unlinkSync(f); } catch {} }
}

// --- start the daemon -------------------------------------------------------

fs.mkdirSync(DATA_DIR, { recursive: true });
console.log('[db:local] starting embedded PostgreSQL (first run downloads binaries)…');
const child = spawn(process.execPath, [daemon], {
  detached: true,
  stdio: 'ignore',
  env: { ...process.env },
});
child.unref();

// Wait for the READY marker AND an actually-accepting socket (pg.start()
// resolves just before postgres begins accepting connections).
for (let i = 0; i < 240; i++) {
  if (fs.existsSync(MARKER) && await portOpen()) break;
  if (child.exitCode !== null) {
    console.error('[db:local] daemon exited before becoming ready — see .pgdata logs');
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 500));
}
if (!fs.existsSync(MARKER) || !await portOpen()) {
  console.error('[db:local] timed out waiting for embedded PostgreSQL');
  process.exit(1);
}
console.log('[db:local] PostgreSQL is up');

// --- point .env at it + run setup -------------------------------------------

dotenv.config({ path: envPath, quiet: true });
process.env.DATABASE_URL = LOCAL_URL;
writeEnv();

const { spawnSync } = await import('node:child_process');
const r = spawnSync(process.execPath, [path.join(SERVER_DIR, 'scripts', 'db-setup.mjs')], {
  stdio: 'inherit',
  env: { ...process.env, DATABASE_URL: LOCAL_URL },
});
process.exit(r.status ?? 1);
