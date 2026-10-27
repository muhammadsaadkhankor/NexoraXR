// NexoraXR database setup — idempotent, safe to re-run.
//
//   node scripts/db-setup.mjs [--soft]
//
// Resolves DATABASE_URL from the environment or src/nexora_server/.env,
// creates the database if the account may, applies pending versioned
// migrations, and verifies the expected tables. Never drops or rewrites data.
// --soft (used by postinstall/CI) prints guidance instead of failing.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { runMigrations } from '../db/migrate.mjs';

const SERVER_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ENV_PATH = path.join(SERVER_DIR, '.env');
const SOFT = process.argv.includes('--soft');

dotenv.config({ path: ENV_PATH, quiet: true });

const EXPECTED_TABLES = [
  'users', 'magic_link_tokens', 'auth_sessions', 'guest_tokens',
  'user_lecture_sessions', 'user_topic_memory', 'user_question_memory',
];

const fail = (msg) => {
  console.error(`\n[db:setup] ${msg}`);
  process.exit(SOFT ? 0 : 1);
};

const ok = (msg) => console.log(`[db:setup] ${msg}`);

function parseUrl(url) {
  try { return new URL(url); } catch { fail(`DATABASE_URL is not a valid URL.`); return null; }
}

function printGuidance() {
  console.log(`
[db:setup] PostgreSQL is not configured or not reachable.

NexoraXR uses PostgreSQL for accounts, sessions, and learning memory.
Pick one option:

  A) Embedded local Postgres (no Docker, no system install):
       npm run db:local
     Downloads a standalone PostgreSQL into src/nexora_server/.pgdata,
     starts it, and writes DATABASE_URL into src/nexora_server/.env.

  B) System PostgreSQL (Linux):
       sudo apt install postgresql   # your choice — needs approval
       createuser nexora -P && createdb -O nexora nexoraxr
       then set DATABASE_URL=postgres://nexora:<pw>@localhost:5432/nexoraxr
       in src/nexora_server/.env and run:  npm run db:setup

  C) Docker (optional):
       docker compose up -d postgres
       DATABASE_URL=postgres://nexora:nexora@localhost:5432/nexoraxr

Then re-run:  npm run db:setup     (verify with: npm run db:status)
Without a database the app still runs, but sign-in is unavailable and
classroom participants are guests only (no raise-hand / AI questions).`);
}

// --- resolve ---------------------------------------------------------------

const url = process.env.DATABASE_URL?.trim();
if (!url) {
  console.log('[db:setup] DATABASE_URL is not set (checked env and src/nexora_server/.env).');
  printGuidance();
  process.exit(SOFT ? 0 : 1);
}

const pg = await import('pg').catch(() => null);
if (!pg?.Pool && !pg?.default?.Pool) {
  fail(`the 'pg' package is not installed — run npm run install:all first.`);
}
const Pool = pg.Pool || pg.default.Pool;

const target = parseUrl(url);
const dbName = decodeURIComponent(target.pathname.replace(/^\//, '')) || 'nexoraxr';
const masked = `${target.protocol}//${target.username ? target.username + '@' : ''}${target.host}/${dbName}`;
ok(`target: ${masked}`);

// --- ensure the database exists ---------------------------------------------

const serverUrl = new URL(url);
serverUrl.pathname = '/postgres';

async function tryPool(connStr) {
  const p = new Pool({ connectionString: connStr, connectionTimeoutMillis: 5000 });
  try { await p.query('SELECT 1'); return p; }
  catch (err) { await p.end().catch(() => {}); throw err; }
}

let serverPool;
try {
  serverPool = await tryPool(serverUrl.toString());
} catch (err) {
  console.log(`[db:setup] cannot reach PostgreSQL server: ${err.message}`);
  printGuidance();
  process.exit(SOFT ? 0 : 1);
}

try {
  const { rows } = await serverPool.query(
    'SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
  if (rows.length === 0) {
    try {
      // CREATE DATABASE can't run in a transaction or parameterized —
      // dbName is validated against a strict identifier regex first.
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(dbName)) {
        fail(`database name '${dbName}' is not a safe identifier.`);
      }
      await serverPool.query(`CREATE DATABASE ${dbName}`);
      ok(`created database '${dbName}'`);
    } catch (err) {
      fail(`database '${dbName}' does not exist and could not be created (${err.message}).
Create it manually or grant CREATE privileges, then re-run npm run db:setup.`);
    }
  } else {
    ok(`database '${dbName}' exists`);
  }
} finally {
  await serverPool.end().catch(() => {});
}

// --- migrate + verify --------------------------------------------------------

let pool;
try {
  pool = await tryPool(url);
} catch (err) {
  fail(`server reachable but cannot connect to '${dbName}': ${err.message}`);
}

try {
  const applied = await runMigrations(pool);
  ok(applied.length ? `applied migrations: ${applied.join(', ')}` : 'schema up to date (no pending migrations)');

  const { rows } = await pool.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ANY($1)`, [EXPECTED_TABLES]);
  const present = new Set(rows.map((r) => r.table_name));
  const missing = EXPECTED_TABLES.filter((t) => !present.has(t));
  if (missing.length) {
    fail(`missing expected tables: ${missing.join(', ')}`);
  }
  ok(`verified ${EXPECTED_TABLES.length} tables — database is ready`);
} finally {
  await pool.end().catch(() => {});
}
