// Floor-control concurrency benchmark — drives the real NCIP Socket.IO server
// with N headless students (socket.io-client, no browser) and measures floor
// acquisition under contention. Server logic is unmodified; the only harness
// hooks are the opt-in EVAL_* env flags.
//
// Usage:
//   node eval/floor/run.mjs                      # full matrix: N in {2,5,10,20}
//                                                # x scenarios x 30 reps
//   EVAL_REPS=2 EVAL_NS=2 EVAL_SCENARIOS=A node eval/floor/run.mjs   # smoke
//
// Env:
//   EVAL_REPS       reps per (scenario, N) cell          (default 30)
//   EVAL_NS         comma list of N values               (default 2,5,10,20)
//   EVAL_SCENARIOS  comma list                           (default A,B,C,
//                                                        D-release,D-disconnect,
//                                                        D-duplicate)
//   EVAL_SEED       base seed; per-rep seed derived      (default 0xC0FFEE)
//   EVAL_PORT       server port                          (default 4100)
//   EVAL_LECTURE    lectureId to play                    (default Lecture_1)
//
// Per (scenario, N) cell the runner spawns a fresh server with EVAL_LOG=1 and
// EVAL_MOCK_PROFESSOR=1 — the mock answers every floor question after a fixed
// 500 ms delay, no LLM/TTS. Server-side records land in
// logs/eval/<runId>.jsonl; per-rep client measurements land in
// eval/floor/results/<runId>.jsonl.
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { mulberry32, expovariate } from './rng.mjs';
import { Student } from './student.mjs';
import { summarize, formatSummary } from './report.mjs';
import { oracleReport } from './oracle.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(__dirname, '../../src/nexora_server');
const RESULTS_DIR = process.env.EVAL_RESULTS_DIR || path.join(__dirname, 'results');
const GRACE_MS = process.env.EVAL_RECONNECT_GRACE_MS
  ? Number(process.env.EVAL_RECONNECT_GRACE_MS) : null;

const PORT = Number(process.env.EVAL_PORT || 4100);
const BASE = `http://localhost:${PORT}`;
const LECTURE_ID = process.env.EVAL_LECTURE || 'Lecture_1';
const REPS = Number(process.env.EVAL_REPS || 30);
// EVAL_REP_SEED pins every rep to one seed — replays a recorded rep.
const REP_SEED = process.env.EVAL_REP_SEED ? Number(process.env.EVAL_REP_SEED) : null;
// Holder re-join delay for D-disconnect-reconnect — sweepable to map the
// kept-rate curve across grace-window sizes.
const REJOIN_DELAY_MS = process.env.EVAL_RECONNECT_DELAY_MS
  ? Number(process.env.EVAL_RECONNECT_DELAY_MS) : 1400;
// Per-rep drain timeout override — mutant runs (e.g. M1 exclusivity breaks)
// deliberately stall some students; bound the wait.
const REP_TIMEOUT_MS = process.env.EVAL_REP_TIMEOUT_MS
  ? Number(process.env.EVAL_REP_TIMEOUT_MS) : null;
const NS = (process.env.EVAL_NS || '2,5,10,20').split(',').map(Number);
const SCENARIOS = (process.env.EVAL_SCENARIOS || 'A,B,C,D-release,D-disconnect,D-disconnect-reconnect,D-duplicate')
  .split(',').map((s) => s.trim()).filter(Boolean);
const BASE_SEED = Number(process.env.EVAL_SEED || 0xC0FFEE);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();

// ---------------------------------------------------------------- server --

function startServer(runId) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      PORT: String(PORT),
      EVAL_LOG: '1',
      EVAL_RUN_ID: runId,
      EVAL_MOCK_PROFESSOR: '1',
      ...(GRACE_MS != null ? { EVAL_RECONNECT_GRACE_MS: String(GRACE_MS) } : {}),
      // Headless participants: legacy client-supplied pids (dev only).
      NXR_DEV_UNAUTH_PROTOCOL: '1',
      // Fixture lectures are baked in English only.
      NXR_START_REQUIRES_ALL_LANGS: '0',
      // Pure prepared segments — no dynamic LLM/TTS utterances.
      NXR_AGENT_DYNAMIC: '0',
      // Belt & suspenders: nothing may reach a real LLM/TTS backend.
      OLLAMA_BASE_URL: 'http://127.0.0.1:9',
      TTS_URL: 'http://127.0.0.1:9',
      NXR_REPAIR_ON_BOOT: '0',
      DATABASE_URL: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // EVAL_SERVER_STDOUT=1 tees server stdout (e.g. [answer-end] telemetry)
  // into the runner console; default stays silent.
  const tee = process.env.EVAL_SERVER_STDOUT === '1';
  child.stdout.on('data', tee ? (d) => process.stdout.write(`[server] ${d}`) : () => {});
  child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  return child;
}

async function waitForServer() {
  for (let i = 0; i < 80; i++) {
    try {
      await fetch(`${BASE}/api/rooms/public`);
      return;
    } catch { await sleep(250); }
  }
  throw new Error('server did not start');
}

// ------------------------------------------------------------- scenarios --

const TERMINAL = new Set(['released', 'disconnected', 'floor-lost', 'answered']);

function wireNormal(st) {
  st.onGrant = (s) => s.submitCheckpoint();
  st.onReady = (s) => s.askQuestion();
  st.onAnswerDone = (s) => s.releaseFloor();
}

// Returns [{ st, delayMs, extraRequests }] and installs per-student behavior.
function planScenario(scenario, students, rng) {
  const plan = [];
  switch (scenario) {
    case 'A': // simultaneous — all N request in the same tick
      for (const st of students) plan.push({ st, delayMs: 0 });
      break;
    case 'B': // burst — uniform spread inside a 200 ms window
      for (const st of students) plan.push({ st, delayMs: rng() * 200 });
      break;
    case 'C': { // Poisson-like arrivals over the lecture
      const order = [...students];
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
      let t = 0;
      for (const st of order) {
        t += expovariate(rng, 600);
        plan.push({ st, delayMs: t });
      }
      break;
    }
    case 'D-release': {
      // First requester grabs the floor and releases while the rest queue.
      const [owner, ...rest] = students;
      owner.onGrant = (s) => setTimeout(() => s.releaseFloor(), 30);
      plan.push({ st: owner, delayMs: 0 });
      for (const st of rest) {
        wireNormal(st);
        plan.push({ st, delayMs: 40 });
      }
      return plan;
    }
    case 'D-disconnect': {
      // First requester vanishes while holding the floor (no checkpoint) —
      // exercises the 10 s reconnect-grace expiry path.
      const [owner, ...rest] = students;
      owner.onGrant = (s) => setTimeout(() => s.disconnect(), 100);
      plan.push({ st: owner, delayMs: 0 });
      for (const st of rest) {
        wireNormal(st);
        plan.push({ st, delayMs: 60 });
      }
      return plan;
    }
    case 'D-disconnect-reconnect': {
      // Holder drops and re-joins (same participantId) inside the grace
      // window — the protocol should hand the floor straight back.
      const [owner, ...rest] = students;
      owner.onGrant = (s) => setTimeout(async () => {
        s.disconnect();
        await sleep(REJOIN_DELAY_MS); // default 1400 ms — inside the 10 s grace window
        try {
          const re = new Student({
            base: BASE, roomId: s.roomId, pid: s.pid, lectureId: s.lectureId,
          });
          re.isReconnect = true;
          re.rec.reconnectOf = s.pid;
          await re.connect();
          wireNormal(re); // wired BEFORE join — the admitting floor-state is
                          // what triggers checkpoint submission
          await re.join();
          students.push(re);
        } catch {
          // A failed rejoin leaves the rep to its timeout — that's data too.
        }
      }, 100);
      plan.push({ st: owner, delayMs: 0 });
      for (const st of rest) {
        wireNormal(st);
        plan.push({ st, delayMs: 60 });
      }
      return plan;
    }
    case 'D-duplicate': {
      // One client spams request-floor — the protocol must dedupe it.
      for (const st of students) plan.push({ st, delayMs: 0 });
      plan.push({ st: students[students.length - 1], delayMs: 20, extraRequests: 4 });
      break;
    }
    default:
      throw new Error(`unknown scenario '${scenario}'`);
  }
  for (const st of students) wireNormal(st);
  return plan;
}

// ------------------------------------------------------------------- rep --

async function waitForStatus(students, status, timeoutMs) {
  const t0 = now();
  while (now() - t0 < timeoutMs) {
    if (students.some((s) => s.professorStatus === status)) return true;
    await sleep(25);
  }
  return false;
}

async function waitForCompletion(students, timeoutMs) {
  const t0 = now();
  while (now() - t0 < timeoutMs) {
    // 'lost' reconnecters are terminal — they can never regain the floor.
    if (students.every((s) => TERMINAL.has(s.rec.outcome)
        || s.rec.reconnectOutcome === 'lost')) return true;
    await sleep(50);
  }
  return false;
}

async function runRep({ scenario, n, rep, seed, runId }) {
  const roomId = `eval-${scenario}-n${n}-r${rep}`;
  const rng = mulberry32(seed);
  const students = [];

  for (let i = 0; i < n; i++) {
    const st = new Student({
      base: BASE, roomId, pid: `r${rep}s${i}`, lectureId: LECTURE_ID,
    });
    await st.connect();
    await st.join();
    students.push(st);
  }

  // Lecture driver: student[0] acknowledges each emitted lecture unit — but
  // only while the room is LECTURING, so a floor pause freezes progression
  // exactly like a real client whose playback is interrupted.
  const driver = students[0];
  driver.s.on('professor-speak', (d) => {
    if (d?.type !== 'lecture' || !d.id || d.floorAnswer) return;
    if (driver.professorStatus !== 'LECTURING') return;
    const m = /^(.+)_seg_(\d+)$/.exec(d.id);
    setTimeout(() => driver.s.emit('lecture-segment-ended', {
      lectureId: d.lectureId || LECTURE_ID,
      segmentId: m ? Number(m[2]) : null,
      messageId: d.id,
    }), 5);
  });

  const t0 = now();
  const repTimeoutMs = REP_TIMEOUT_MS ?? Math.max(60_000, 20_000 + n * 5_000);

  try {
    driver.s.emit('lecture.start', { lectureId: LECTURE_ID });
    if (!(await waitForStatus(students, 'LECTURING', 20_000))) {
      throw new Error('lecture never reached LECTURING');
    }

    // All requests are timestamped against this mark — scenario scheduling is
    // replayed deterministically from the seed.
    const plan = planScenario(scenario, students, rng);
    for (const { st, delayMs, extraRequests = 0 } of plan) {
      setTimeout(() => {
        if (!st.s.connected) return;
        st.requestFloor();
        for (let k = 0; k < extraRequests; k++) {
          setTimeout(() => st.s.connected && st.requestFloor(), 20 * (k + 1));
        }
      }, delayMs);
    }

    const finished = await waitForCompletion(students, repTimeoutMs);
    await sleep(300); // let the final floor-state settle

    const grantOrder = students
      .filter((s) => s.rec.tGrant != null)
      .sort((a, b) => a.rec.tGrant - b.rec.tGrant)
      .map((s) => s.pid);

    // Request arrival order as seen client-side (all students share one
    // process clock) — the oracle re-checks it against the server log.
    const reqRank = new Map(
      students.filter((s) => s.rec.tRequest != null)
        .sort((a, b) => a.rec.tRequest - b.rec.tRequest)
        .map((s, i) => [s.pid, i]));

    // Per-handoff rows: consecutive grantees. prevEnd = the moment the floor
    // left the previous holder (release emit, disconnect, or answer end).
    const granted = students.filter((s) => s.rec.tGrant != null)
      .sort((a, b) => a.rec.tGrant - b.rec.tGrant);
    const handoffs = [];
    for (let i = 1; i < granted.length; i++) {
      const prev = granted[i - 1].rec;
      const next = granted[i].rec;
      const prevEnd = prev.tRelease ?? prev.tDisconnect ?? prev.tAnswerEnd ?? null;
      // Contested handoff = the next grantee's request was already pending
      // when the floor left the previous holder. If the request arrived
      // later, the gap is idle time, not handoff latency. Reconnect "grants"
      // (same pid, rejoined) are grace recoveries — a separate metric, as
      // are transfers whose previous holder ended by disconnect.
      const kind = granted[i].isReconnect ? 'reconnect'
        : (prev.tRelease == null && prev.tDisconnect != null) ? 'disconnect'
        : (next.tRequest != null && prevEnd != null && next.tRequest < prevEnd)
          ? 'contested' : 'idle';
      handoffs.push({
        prevPid: prev.pid, nextPid: next.pid, kind,
        prevRelease: prevEnd != null ? Math.round(prevEnd) : null,
        nextGrant: Math.round(next.tGrant),
        handoffMs: kind !== 'idle' && prevEnd != null
          ? Math.round(next.tGrant - prevEnd) : null,
        idleGapMs: kind === 'idle' && prevEnd != null && next.tRequest != null
          ? Math.round(next.tRequest - prevEnd) : null,
        reqRank: reqRank.get(next.pid) ?? null,
        grantRank: i,
      });
    }

    // Disconnect metrics: for each dropped socket, when the NEXT grant lands
    // (the queued student for D-disconnect, the rejoined holder for
    // D-disconnect-reconnect — same pid, isReconnect flag distinguishes it).
    const disconnects = students
      .filter((s) => s.rec.tDisconnect != null)
      .map((s) => {
        const nextG = students
          .filter((o) => o.rec.tGrant != null && o.rec.tGrant > s.rec.tDisconnect)
          .sort((a, b) => a.rec.tGrant - b.rec.tGrant)[0];
        const re = students.find((o) => o.isReconnect && o.pid === s.pid);
        return {
          pid: s.pid,
          tDisconnect: Math.round(s.rec.tDisconnect),
          tDisconnectWall: s.rec.tDisconnectWall,
          nextGrantPid: nextG?.pid ?? null,
          nextGrant: nextG ? Math.round(nextG.rec.tGrant) : null,
          floorRecoveryMs: nextG ? Math.round(nextG.rec.tGrant - s.rec.tDisconnect) : null,
          reconnectOutcome: re?.rec.reconnectOutcome ?? null,
        };
      });

    const starved = students.filter((s) =>
      s.rec.tRequest != null && s.rec.tGrant == null).length;

    return {
      type: 'rep', runId, scenario, n, rep, seed, roomId,
      durationMs: Math.round(now() - t0), finished,
      grantOrder, handoffs, disconnects, starved,
      students: students.map((s) => ({
        ...s.rec,
        isReconnect: s.isReconnect || false,
        floorObs: s.floorObs.slice(-200),
        requestToGrantMs:
          s.rec.tGrant != null && s.rec.tRequest != null
            ? Math.round(s.rec.tGrant - s.rec.tRequest) : null,
        answerMs:
          s.rec.tAnswerEnd != null && s.rec.tAnswerStart != null
            ? Math.round(s.rec.tAnswerEnd - s.rec.tAnswerStart) : null,
      })),
    };
  } finally {
    for (const st of students) {
      if (st.s.connected) st.leave();
    }
    await sleep(150);
    for (const st of students) st.disconnect();
  }
}

// ------------------------------------------------------------------ main --

// ------------------------------------------------------------- reporting --

const EVAL_LOG_DIR = path.resolve(__dirname, '../../logs/eval');
const pctile = (xs, p) => {
  if (!xs.length) return '';
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]);
};

const cellAgg = new Map(); // 'scenario|n' -> aggregate
const aggFor = (scenario, n) => {
  const k = `${scenario}|${n}`;
  if (!cellAgg.has(k)) {
    cellAgg.set(k, {
      scenario, n, runs: 0, finished: 0, starved: 0,
      collisions: 0, transitionViolations: 0, fifoViolations: 0,
      waits: [], handoffs: [], idleGaps: [], recoveries: [], detections: [],
      reconnect: { kept: 0, requeued: 0, lost: 0 },
    });
  }
  return cellAgg.get(k);
};

// After a cell's reps: replay the server eval log through the oracle, write
// the oracle + disconnect records into the results file, and emit the
// per-handoff CSV.
function postProcessCell({ runId, scenario, n, cellReps, resultsFile }) {
  const serverLog = path.join(EVAL_LOG_DIR, `${runId}.jsonl`);
  const agg = aggFor(scenario, n);
  for (const rec of cellReps) {
    agg.runs++;
    if (rec.finished) agg.finished++;
    agg.starved += rec.starved || 0;
    for (const s of rec.students || []) {
      if (s.requestToGrantMs != null) agg.waits.push(s.requestToGrantMs);
      if (s.reconnectOutcome && agg.reconnect[s.reconnectOutcome] != null) {
        agg.reconnect[s.reconnectOutcome]++;
      }
    }
    for (const h of rec.handoffs || []) {
      if (h.kind === 'contested' && h.handoffMs != null) agg.handoffs.push(h.handoffMs);
      if (h.kind === 'idle' && h.idleGapMs != null) agg.idleGaps.push(h.idleGapMs);
    }
    for (const d of rec.disconnects || []) {
      if (d.floorRecoveryMs != null) agg.recoveries.push(d.floorRecoveryMs);
    }
  }

  const ora = oracleReport(serverLog, cellReps);
  agg.collisions += ora.totals.ownerMismatches;
  agg.transitionViolations += ora.totals.transitionViolations;
  agg.fifoViolations += ora.totals.fifoViolations;
  const oraRec = { type: 'oracle', runId, scenario, n, ...ora.totals };
  fs.appendFileSync(resultsFile, `${JSON.stringify(oraRec)}\n`);

  // Per-rep disconnect records: client tDisconnectWall vs server detectWall.
  for (const rec of cellReps) {
    const roomOra = ora.perRoom[rec.roomId];
    for (const d of rec.disconnects || []) {
      const sd = (roomOra?.disconnects || []).find((x) => x.pid === d.pid);
      const detectionMs =
        sd?.detectWall != null && d.tDisconnectWall != null
          ? Math.round(sd.detectWall - d.tDisconnectWall) : null;
      if (detectionMs != null) agg.detections.push(detectionMs);
      fs.appendFileSync(resultsFile, `${JSON.stringify({
        type: 'disconnect', runId, scenario, n, rep: rec.rep,
        roomId: rec.roomId, pid: d.pid,
        tDisconnectWall: d.tDisconnectWall,
        detectWall: sd?.detectWall ?? null,
        detectionMs,
        removedWall: sd?.removedWall ?? null,
        reassignWall: sd?.reassignWall ?? null,
        rejoinWall: sd?.rejoinWall ?? null,
        nextOwner: sd?.nextOwner ?? null,
        floorRecoveryMs: d.floorRecoveryMs,
        reconnectOutcome: d.reconnectOutcome,
      })}\n`);
    }
  }

  // Per-handoff CSV — FIFO compliance (reqRank vs grantRank) + latency.
  const csv = [
    'runId,scenario,n,rep,roomId,prevPid,nextPid,kind,prevRelease,nextGrant,handoffMs,idleGapMs,reqRank,grantRank',
  ];
  for (const rec of cellReps) {
    for (const h of rec.handoffs || []) {
      csv.push([
        runId, scenario, n, rec.rep, rec.roomId,
        h.prevPid, h.nextPid, h.kind ?? '', h.prevRelease ?? '', h.nextGrant ?? '',
        h.handoffMs ?? '', h.idleGapMs ?? '', h.reqRank ?? '', h.grantRank ?? '',
      ].join(','));
    }
  }
  fs.writeFileSync(
    path.join(RESULTS_DIR, `handoffs_${runId}.csv`), `${csv.join('\n')}\n`);

  console.log(`[bench] oracle ${scenario} n=${n}: ` +
    `transitions=${ora.totals.transitionViolations} ` +
    `ownerMismatch=${ora.totals.ownerMismatches} ` +
    `fifo=${ora.totals.fifoViolations}`);
}

function writeSummaryCsv(stamp) {
  const header = 'scenario,n,runs,collisions,oracleViolations,fifoViolations,' +
    'starvation,handoffMs_p50,handoffMs_p95,handoffMs_max,' +
    'idleGapMs_p50,idleGapMs_p95,' +
    'waitMs_p50,waitMs_p95,waitMs_max,floorRecoveryMs_p50,floorRecoveryMs_p95,reconnectKept';
  const rows = [...cellAgg.values()]
    .sort((a, b) => a.scenario === b.scenario ? a.n - b.n
      : a.scenario.localeCompare(b.scenario))
    .map((c) => [
      c.scenario, c.n, c.runs, c.collisions, c.transitionViolations,
      c.fifoViolations, c.starved,
      pctile(c.handoffs, 0.5), pctile(c.handoffs, 0.95), pctile(c.handoffs, 1),
      pctile(c.idleGaps, 0.5), pctile(c.idleGaps, 0.95),
      pctile(c.waits, 0.5), pctile(c.waits, 0.95), pctile(c.waits, 1),
      pctile(c.recoveries, 0.5), pctile(c.recoveries, 0.95),
      c.reconnect.kept || '',
    ].join(','));
  const file = path.join(RESULTS_DIR, `summary_${stamp}.csv`);
  fs.writeFileSync(file, `${header}\n${rows.join('\n')}\n`);
  return file;
}

async function main() {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const cells = [];
  for (const n of NS) for (const scenario of SCENARIOS) cells.push({ scenario, n });

  console.log(`[bench] ${cells.length} cells x ${REPS} reps | N=[${NS}] scenarios=[${SCENARIOS}] seed=${BASE_SEED}`);

  const allReps = [];

  for (const { scenario, n } of cells) {
    const runId = `floor_${scenario}_n${n}${GRACE_MS != null ? `_g${GRACE_MS}` : ''}` +
      `${process.env.EVAL_RECONNECT_DELAY_MS ? `_d${REJOIN_DELAY_MS}` : ''}` +
      `${process.env.EVAL_MUTANT ? `_m${process.env.EVAL_MUTANT}` : ''}_${stamp}`;
    const server = startServer(runId);
    const resultsFile = path.join(RESULTS_DIR, `${runId}.jsonl`);
    const cellReps = [];
    try {
      await waitForServer();
      for (let rep = 0; rep < REPS; rep++) {
        // Deterministic per-rep seed — recorded in every rep row.
        // Seed depends on the scenario NAME, not its position in EVAL_SCENARIOS
        // — identical whether cells run in one process or parallel shards.
        // EVAL_REP_SEED forces one fixed seed for every rep (replays).
        const scenSeed = [...scenario].reduce((a, c) => a + c.charCodeAt(0), 0);
        const seed = REP_SEED ?? ((BASE_SEED + rep * 0x9E3779B1 + n * 0x85EBCA6B
          + scenSeed * 0xC2B2AE35) >>> 0);
        const t = now();
        try {
          const rec = await runRep({ scenario, n, rep, seed, runId });
          allReps.push(rec);
          cellReps.push(rec);
          fs.appendFileSync(resultsFile, `${JSON.stringify(rec)}\n`);
          const grants = new Set(
            rec.students.filter((s) => s.tGrant != null).map((s) => s.pid)).size;
          const med = rec.students
            .map((s) => s.requestToGrantMs).filter((v) => v != null)
            .sort((a, b) => a - b)[Math.floor(grants / 2)] ?? '-';
          const disc = rec.disconnects?.length
            ? ` recovery=${rec.disconnects[0].floorRecoveryMs}ms` +
              (rec.disconnects[0].reconnectOutcome
                ? `(${rec.disconnects[0].reconnectOutcome})` : '')
            : '';
          console.log(`[bench] ${scenario} n=${n} rep=${rep} seed=${seed} ` +
            `grants=${grants}/${n} medianReqToGrant=${med}ms drain=${rec.durationMs}ms ` +
            `${rec.finished ? 'ok' : 'TIMEOUT'}${disc} (${Math.round(now() - t)}ms)`);
        } catch (err) {
          const failRec = {
            type: 'rep', runId, scenario, n, rep, seed,
            error: String(err?.message || err), finished: false,
          };
          allReps.push(failRec);
          fs.appendFileSync(resultsFile, `${JSON.stringify(failRec)}\n`);
          console.error(`[bench] ${scenario} n=${n} rep=${rep} FAILED: ${err.message}`);
        }
      }
      postProcessCell({ runId, scenario, n, cellReps, resultsFile });
    } finally {
      server.kill('SIGKILL');
      await sleep(300);
    }
    console.log(`[bench] done ${scenario} n=${n} -> ${resultsFile} + logs/eval/${runId}.jsonl`);
  }
  console.log('[bench] matrix complete');
  const summaryFile = writeSummaryCsv(stamp);
  console.log(`[bench] summary -> ${summaryFile}`);
  console.log(`\n${formatSummary(summarize(allReps))}`);
}

process.on('SIGINT', () => process.exit(130));
main().catch((e) => { console.error(e); process.exit(1); });
