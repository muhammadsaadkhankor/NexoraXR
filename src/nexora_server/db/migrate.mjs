// Versioned schema migrations — minimal runner, no external dependency.
//
// Each file in db/migrations/NNNN_name.sql is applied exactly once, in
// filename order, inside its own transaction. Applied versions are recorded
// in schema_migrations(version). Re-running is a no-op; a failed file rolls
// back cleanly and aborts the boot migration (error propagates to initDb).
//
// The runner executes each file as a single multi-statement query — pg and
// pg-mem both support that, so migrations are testable in-process.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

async function appliedVersions(client) {
  // Existence check first: pg-mem (test adapter) fails to plan
  // CREATE TABLE IF NOT EXISTS when the table already exists.
  const exists = await client.query(
    `SELECT 1 FROM information_schema.tables WHERE table_name = 'schema_migrations'`);
  if (exists.rows.length === 0) {
    await client.query(
      `CREATE TABLE schema_migrations (
         version    TEXT NOT NULL,
         applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
         PRIMARY KEY (version)
       )`);
  }
  const { rows } = await client.query('SELECT version FROM schema_migrations');
  return new Set(rows.map((r) => r.version));
}

// Returns the list of versions applied by this call (empty when up to date).
export async function runMigrations(p, dir = MIGRATIONS_DIR) {
  let files = [];
  try {
    files = (await fs.readdir(dir))
      .filter((f) => /^\d+_.+\.sql$/.test(f))
      .sort();
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const done = await appliedVersions(p);
  const applied = [];
  for (const file of files) {
    const version = file.replace(/\.sql$/, '');
    if (done.has(version)) continue;
    const sql = await fs.readFile(path.join(dir, file), 'utf-8');
    const client = p.connect ? await p.connect() : p;
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
      await client.query('COMMIT');
      applied.push(version);
      console.log(`[db] migration applied: ${version}`);
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
      throw new Error(`migration ${version} failed: ${err.message}`);
    } finally {
      client.release?.();
    }
  }
  return applied;
}
