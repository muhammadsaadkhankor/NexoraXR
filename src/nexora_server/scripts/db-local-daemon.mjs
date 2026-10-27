// Embedded PostgreSQL daemon — started detached by db-local.mjs.
// Keeps a standalone Postgres instance running on localhost:5432 with data in
// src/nexora_server/.pgdata. Writes a READY marker file once accepting
// connections; exits on SIGTERM/SIGINT.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgresInstance } from 'pg-embedded';
import { PORT, DATA_DIR, CLUSTER_DIR, MARKER, PID_FILE, LOCAL_URL } from './db-local.shared.mjs';

fs.mkdirSync(DATA_DIR, { recursive: true });

let pg = null;
const shutdown = async () => {
  try { if (pg) await pg.stop(); } catch {}
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

pg = new PostgresInstance({
  port: PORT,
  username: 'postgres',
  password: 'postgres',
  dataDir: CLUSTER_DIR,
  persistent: true,
});

try {
  await pg.start();
  // Write pid + marker only after a successful start — a failed second
  // daemon must not clobber a live one's bookkeeping.
  fs.writeFileSync(PID_FILE, String(process.pid));
  fs.writeFileSync(MARKER, LOCAL_URL);
  console.log(`[db-local] embedded PostgreSQL ready at ${LOCAL_URL}`);
  // Keepalive: pg-embedded manages postgres as a child of this process —
  // if the node process exits, the DB is stopped. Stay alive.
  setInterval(() => {}, 60_000);
} catch (err) {
  console.error(`[db-local] failed to start embedded PostgreSQL: ${err.message}`);
  process.exit(1);
}
