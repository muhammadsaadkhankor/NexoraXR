// Shared constants for the embedded local Postgres instance.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SERVER_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const DATA_DIR = path.join(SERVER_DIR, '.pgdata');      // wrapper dir (pid/marker live here)
export const CLUSTER_DIR = path.join(DATA_DIR, 'data');        // actual PG data dir (must stay empty for initdb)
export const MARKER = path.join(DATA_DIR, '.ready');
export const PID_FILE = path.join(DATA_DIR, '.pid');
// 5433 by default — 5432 is where a real Postgres (system/docker) usually
// lives; colliding would let a stale marker pass the port check against the
// WRONG server. Override with NXR_LOCAL_PG_PORT.
export const PORT = Number(process.env.NXR_LOCAL_PG_PORT) || 5433;
export const LOCAL_URL = `postgres://postgres:postgres@localhost:${PORT}/nexoraxr`;
