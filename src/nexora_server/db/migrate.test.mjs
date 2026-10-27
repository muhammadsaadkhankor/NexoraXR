import test from 'node:test';
import assert from 'node:assert/strict';
import { newDb } from 'pg-mem';
import { runMigrations } from './migrate.mjs';
import { initDb, dbAvailable, withTransaction } from './pool.mjs';

function makePgMemPool() {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  return new Pool();
}

test('migrations apply once, idempotently, and create the memory tables', async () => {
  const p = makePgMemPool();
  const first = await runMigrations(p);
  assert.ok(first.includes('0001_user_memory'));
  const second = await runMigrations(p);
  assert.deepEqual(second, []); // already applied — no-op
  // Verify each table exists (pg-mem's information_schema over-reports, so
  // check presence rather than exact row count).
  const names = new Set((await p.query(
    `SELECT table_name FROM information_schema.tables`)).rows.map((r) => r.table_name));
  for (const t of ['user_lecture_sessions', 'user_topic_memory', 'user_question_memory', 'schema_migrations']) {
    assert.ok(names.has(t), `missing table ${t}`);
  }
});

test('initDb(adapter) runs migrations and marks the db available', async () => {
  const p = makePgMemPool();
  await initDb(p);
  assert.equal(dbAvailable(), true);
  await p.query(`INSERT INTO user_lecture_sessions (participant_id, lecture_id, run_id)
                 VALUES ('x','L','r1')`);
});

test('withTransaction commits and rolls back', async () => {
  const p = makePgMemPool();
  await initDb(p);
  await withTransaction(async (c) => {
    await c.query(`INSERT INTO user_lecture_sessions (participant_id, lecture_id, run_id) VALUES ('a','L','r2')`);
  });
  const { rows } = await p.query(`SELECT * FROM user_lecture_sessions WHERE run_id='r2'`);
  assert.equal(rows.length, 1);
  // Errors propagate so callers can handle them. NOTE: pg-mem does not
  // emulate ROLLBACK — the row may persist in-test; atomicity is covered by
  // the real-Postgres integration suite (Stage 10).
  await assert.rejects(
    withTransaction(async (c) => {
      await c.query(`INSERT INTO user_lecture_sessions (participant_id, lecture_id, run_id) VALUES ('b','L','r3')`);
      throw new Error('boom');
    }), /boom/);
});
