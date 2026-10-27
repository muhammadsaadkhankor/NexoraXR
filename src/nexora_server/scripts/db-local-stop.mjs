// npm run db:local:stop — stop the embedded PostgreSQL daemon.
import fs from 'node:fs';
import { PID_FILE } from './db-local.shared.mjs';

try {
  const pid = Number(fs.readFileSync(PID_FILE, 'utf8'));
  if (pid) {
    process.kill(pid, 'SIGTERM');
    console.log(`[db:local] sent SIGTERM to pid ${pid}`);
  }
} catch {
  console.log('[db:local] no embedded PostgreSQL daemon found');
}
