// Generate a complete Markdown evaluation report from benchmark artifacts.
//
//   node eval/floor/markdown.mjs [resultsDir] [logsDir] [out.md]
//
// Defaults: eval/floor/results , logs/eval , eval/floor/results/REPORT.md
// Covers: methodology, oracle/correctness totals, per-cell summary table,
// disconnect/recovery detail, and the metric definitions.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildCells, pctile } from './summarize.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = process.argv[2] || path.join(__dirname, 'results');
const LOGS_DIR = process.argv[3] || path.resolve(__dirname, '../../logs/eval');
const OUT = process.argv[4] || path.join(RESULTS_DIR, 'REPORT.md');

const SCENARIO_DESC = {
  'A': 'Simultaneous requests — all N students request the floor in the same tick',
  'B': 'Burst — requests uniformly spread over a 200 ms window',
  'C': 'Poisson — seeded exponential inter-arrival times over the lecture',
  'D-release': 'Adversarial — holder releases while others are queued',
  'D-disconnect': 'Adversarial — holder disconnects while holding the floor (no reconnect)',
  'D-disconnect-reconnect': 'Adversarial — holder disconnects and re-joins within ~1.5 s (inside the 10 s grace window)',
  'D-duplicate': 'Adversarial — one student emits 6 duplicate request-floor events',
};

const md = (xs) => xs.join('\n');
const msCell = (v) => (v === '' || v == null ? '–' : `${v}`);

function gitInfo() {
  try {
    const hash = execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim();
    const dirty = execSync('git status --porcelain', { encoding: 'utf-8' }).trim();
    return `${hash}${dirty ? ' (working tree dirty)' : ' (clean)'}`;
  } catch {
    return 'unknown (not a git checkout)';
  }
}

function summaryTable(rows) {
  const head = [
    '| Scenario | N | Runs | Collisions | Oracle viol. | FIFO viol. | Starved | Handoff p50 | Handoff p95 | Handoff max | Idle gap p50 | Idle gap p95 | Wait p50 | Wait p95 | Wait max | Recovery p50 | Recovery p95 | Kept |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  const body = rows.map((c) =>
    `| ${c.scenario} | ${c.n} | ${c.runs} | ${c.collisions} | ` +
    `${c.transitionViolations} | ${c.fifoViolations} | ${c.starved} | ` +
    `${msCell(pctile(c.handoffs, 0.5))} | ${msCell(pctile(c.handoffs, 0.95))} | ` +
    `${msCell(pctile(c.handoffs, 1))} | ${msCell(pctile(c.idleGaps, 0.5))} | ` +
    `${msCell(pctile(c.idleGaps, 0.95))} | ${msCell(pctile(c.waits, 0.5))} | ` +
    `${msCell(pctile(c.waits, 0.95))} | ${msCell(pctile(c.waits, 1))} | ` +
    `${msCell(pctile(c.recoveries, 0.5))} | ${msCell(pctile(c.recoveries, 0.95))} | ` +
    `${c.reconnect.kept || '–'} |`);
  return [...head, ...body].join('\n');
}

function disconnectTable(rows) {
  const cells = rows.filter((c) => c.detections.length || c.recoveries.length);
  if (!cells.length) return '_No disconnect events recorded._';
  const head = [
    '| Scenario | N | Detection p50 / p95 (ms) | Recovery p50 / p95 (ms) | Reconnect kept |',
    '|---|---|---|---|---|',
  ];
  const body = cells.map((c) =>
    `| ${c.scenario} | ${c.n} | ${msCell(pctile(c.detections, 0.5))} / ` +
    `${msCell(pctile(c.detections, 0.95))} | ${msCell(pctile(c.recoveries, 0.5))} / ` +
    `${msCell(pctile(c.recoveries, 0.95))} | ${c.reconnect.kept || '–'} |`);
  return [...head, ...body].join('\n');
}

function main() {
  const { rows, oracleTotals } = buildCells(RESULTS_DIR, LOGS_DIR);
  if (!rows.length) {
    console.error(`warning: no rep records found in ${path.resolve(RESULTS_DIR)}` +
      ` — expected eval/floor/results/floor_*.jsonl`);
  }
  const totalRuns = rows.reduce((a, c) => a + c.runs, 0);
  const totalFinished = rows.reduce((a, c) => a + c.finished, 0);
  const scenarios = [...new Set(rows.map((c) => c.scenario))];
  const ns = [...new Set(rows.map((c) => c.n))].sort((a, b) => a - b);

  const cpu = os.cpus()[0]?.model?.trim() || 'unknown';
  const ram = `${(os.totalmem() / 2 ** 30).toFixed(1)} GB`;
  const doc = md([
    '# NCIP Floor-Control Benchmark Report',
    '',
    `_Generated ${new Date().toISOString()}_`,
    '',
    '## Environment',
    '',
    `- Machine: \`${os.hostname()}\` (${os.type()} ${os.release()})`,
    `- CPU: ${cpu} × ${os.cpus().length}`,
    `- RAM: ${ram}`,
    `- Node: ${process.version}`,
    '- Transport: Socket.IO over **localhost loopback only** (no LAN/WAN latency)',
    `- Commit: \`${gitInfo()}\``,
    '- Auth: bypassed via `NXR_DEV_UNAUTH_PROTOCOL=1` (dev-only, client-supplied pids)',
    '',
    '## Methodology',
    '',
    `Headless Socket.IO benchmark (\`eval/floor/\`) driving the real`,
    `\`NcipRoom\` state machine on a spawned \`server.js\`. Opt-in instrumentation`,
    `only: \`EVAL_LOG=1\` (JSONL event trace to \`logs/eval/\`),`,
    `\`EVAL_MOCK_PROFESSOR=1\` (deterministic 500 ms answer, no LLM/TTS),`,
    `\`NXR_DEV_UNAUTH_PROTOCOL=1\`. No server logic modified.`,
    '',
    `**Matrix:** ${scenarios.length} scenarios × N = {${ns.join(', ')}} ` +
    `students — **${totalRuns} reps across ${rows.length} cells** ` +
    `(${totalFinished} completed, ${totalRuns - totalFinished} timed out).`,
    '',
    '### Scenarios',
    '',
    ...scenarios.map((s) => `- **${s}** — ${SCENARIO_DESC[s] || s}`),
    '',
    '## Correctness (oracle replay of server eval logs)',
    '',
    `Replayed **${oracleTotals.rooms} room traces** (one per rep):`,
    '',
    `- Illegal professor-state transitions: **${oracleTotals.transitionViolations}**`,
    `- Client-vs-server floor-owner mismatches (collisions): ` +
    `**${oracleTotals.ownerMismatches}** across ${oracleTotals.compared.toLocaleString()} ` +
    `stateVersion-matched belief checks`,
    `- FIFO violations (grant order ≠ request arrival order): ` +
    `**${oracleTotals.fifoViolations}**`,
    '',
    '## Summary (per scenario × N)',
    '',
    '_All durations in ms. Wait = request→grant. Handoff = previous holder\'s',
    'floor-end → next grant. Recovery = disconnect → next grant._',
    '',
    summaryTable(rows),
    '',
    '## Disconnect / recovery detail',
    '',
    '_Detection = server `in.disconnect` wall-clock − client `tDisconnectWall`.',
    'The ~10 s D-disconnect recovery is the intended `RECONNECT_GRACE_MS = 10_000`',
    'reconnect window (`ncipRoom.mjs`), not transport timeout: detection itself',
    'is ~1 ms._',
    '',
    disconnectTable(rows),
    '',
    '## Metric definitions',
    '',
    '| Metric | Source | Meaning |',
    '|---|---|---|',
    '| `requestToGrantMs` | client | request-floor emit → floor-state holder=self |',
    '| `handoffMs` | client | contested handoffs only: next request already pending when floor left the previous holder — disconnect-driven transfers excluded (counted as `floorRecoveryMs`) |',
    '| `idleGapMs` | client | floor sat unowned: prev holder-end → next request arrival (excluded from handoffMs) |',
    '| `answerMs` | client | professor-speak (answering) → answer end |',
    '| `detectionMs` | server wall − client wall | socket close → server `disconnect` handling |',
    '| `floorRecoveryMs` | client | holder disconnect → next floor grant |',
    '| `collisions` | oracle | clients believing different owners at same stateVersion |',
    '| `oracleViolations` | oracle | professor-state transitions outside allowed table |',
    '| `fifoViolations` | oracle | grants out of request-floor arrival order |',
    '| `starvation` | rep | students that requested but were never granted |',
    '| `reconnectKept` | rep | reconnecting holder regained its floor slot |',
    '',
    '## Artifacts',
    '',
    '- Client measurements: `eval/floor/results/floor_<scenario>_n<N>_<stamp>.jsonl`',
    '- Server event traces: `logs/eval/<runId>.jsonl` (same stamp)',
    '- Per-handoff rows: `eval/floor/results/handoffs_<runId>.csv`',
    '- Regenerate: `node eval/floor/markdown.mjs [resultsDir] [logsDir] [out.md]`',
    '',
  ]);

  fs.writeFileSync(OUT, doc);
  console.log(`wrote ${OUT}`);
}

main();
