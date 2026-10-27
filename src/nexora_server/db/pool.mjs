// Shared PostgreSQL pool — the single connection owner for the whole server.
//
// Hot path contract: ALL non-critical writes go through `persist(task)` —
// queued fire-and-forget. Nothing in the lecture loop ever awaits a DB write.
// If Postgres is unavailable the module degrades to `noop` (logged once);
// RAM state keeps working, persistence is just skipped.
//
// Backend selection:
//   DATABASE_URL set -> real pg Pool (migrations auto-run unless disabled)
//   adapter injected -> any Pool-compatible object (e.g. pg-mem), migrations
//                       run by default — pass { migrate: false } to skip
//   neither          -> noop (degraded mode)

import { runMigrations } from './migrate.mjs';

let pool = null;

// Pass a Pool-compatible adapter in tests (pg-mem), or rely on DATABASE_URL.
// `initDb` owns boot-time schema: it applies every pending file in
// db/migrations/ unless { migrate: false } is given (tests that create tables
// manually or boot-time callers that already migrated).
export async function initDb(adapter = null, { migrate = true } = {}) {
  if (adapter) {
    pool = adapter;
    if (migrate) await runMigrations(pool);
    return pool;
  }
  if (!process.env.DATABASE_URL) { pool = null; return null; }
  try {
    // pg is CJS: named exports aren't guaranteed through the ESM namespace.
    const pg = await import('pg');
    const Pool = pg.Pool || pg.default?.Pool;
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    if (migrate) await runMigrations(pool);
    return pool;
  } catch (err) {
    console.error('[db] Postgres unavailable — persistence degraded:', err.message);
    pool = null;
    return null;
  }
}

export function getPool() { return pool; }
export function dbAvailable() { return !!pool; }

// Queued fire-and-forget write. Never throws, never awaited by callers.
export function persist(task) {
  if (!pool) return;
  Promise.resolve()
    .then(() => task(pool))
    .catch((err) => console.error('[db] write failed (non-fatal):', err.message));
}

// Critical-path transaction: caller MUST await. fn receives a dedicated client
// — all repo writes inside fn share one transaction; COMMIT on success,
// ROLLBACK on throw. Only for correctness-sensitive operations (auth,
// enrollment, admission, session close) — never the lecture hot path.
export async function withTransaction(fn) {
  if (!pool) throw new Error('database unavailable');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  } finally {
    client.release();
  }
}
