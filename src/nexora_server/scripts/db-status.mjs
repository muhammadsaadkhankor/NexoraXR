// NexoraXR database status — connectivity, database name, migration state.
// Never prints credentials.
//
//   node scripts/db-status.mjs [--quiet]
//     --quiet: one-line verdict for predev hooks; always exits 0.

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const SERVER_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MIGRATIONS_DIR = path.join(SERVER_DIR, 'db', 'migrations');
const QUIET = process.argv.includes('--quiet');

dotenv.config({ path: path.join(SERVER_DIR, '.env'), quiet: true });

const say = (m) => { if (!QUIET) console.log(m); };

const url = process.env.DATABASE_URL?.trim();
if (!url) {
  say('[db:status] DATABASE_URL not configured — app runs without persistence/auth.');
  process.exit(0);
}
const u = new URL(url);
const dbName = decodeURIComponent(u.pathname.replace(/^\//, ''));
say(`[db:status] target ${u.protocol}//${u.username ? u.username + '@' : ''}${u.host}/${dbName}`);

const pg = await import('pg').catch(() => null);
const Pool = pg?.Pool || pg?.default?.Pool;
if (!Pool) { say('[db:status] pg package not installed'); process.exit(0); }

const pool = new Pool({ connectionString: url, connectionTimeoutMillis: 4000 });
try {
  const { rows: [{ v }] } = await pool.query('SELECT version() AS v');
  say(`[db:status] connected — ${String(v).split(' ').slice(0, 2).join(' ')}`);

  const { rows: appliedRows } = await pool.query(
    `SELECT version FROM schema_migrations ORDER BY version`).catch(() => ({ rows: [] }));
  const applied = new Set(appliedRows.map((r) => r.version));
  const files = (fs.existsSync(MIGRATIONS_DIR) ? fs.readdirSync(MIGRATIONS_DIR) : [])
    .filter((f) => /^\d+_.+\.sql$/.test(f)).sort().map((f) => f.replace(/\.sql$/, ''));
  const pending = files.filter((f) => !applied.has(f));
  say(`[db:status] migrations: ${applied.size} applied, ${pending.length} pending${pending.length ? ` (${pending.join(', ')})` : ''}`);

  const { rows: t } = await pool.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema='public'`);
  say(`[db:status] tables: ${t.length}`);
  if (pending.length) say('[db:status] run npm run db:setup to apply pending migrations');
  if (QUIET) console.log(`[db] ${u.host}/${dbName} reachable, ${pending.length} pending migration(s)`);
} catch (err) {
  say(`[db:status] unreachable: ${err.message}`);
  if (QUIET) console.log(`[db] WARNING: PostgreSQL unreachable (${err.message}) — sign-in unavailable until npm run db:setup succeeds`);
} finally {
  await pool.end().catch(() => {});
}
