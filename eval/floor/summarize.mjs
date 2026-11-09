// Recompute the per-(scenario,N) summary from already-produced files:
// rep records in eval/floor/results/*.jsonl joined to server traces in
// logs/eval/<runId>.jsonl through the oracle.
//
//   node eval/floor/summarize.mjs [resultsDir] [logsDir] [outCsv]
//
// Defaults: eval/floor/results , logs/eval , prints to stdout if no outCsv.
// buildCells() is also imported by markdown.mjs for the .md report.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { oracleReport } from './oracle.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const pctile = (xs, p) => {
  if (!xs.length) return '';
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]);
};

const isRepFile = (f) => f.endsWith('.jsonl') && f.startsWith('floor_');

export function loadRepRecords(resultsDir, filter = isRepFile) {
  const repsByRun = new Map(); // runId -> rep records
  if (!fs.existsSync(resultsDir)) return repsByRun;
  for (const f of fs.readdirSync(resultsDir).filter(filter).sort()) {
    for (const line of fs.readFileSync(path.join(resultsDir, f), 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      let r;
      try { r = JSON.parse(line); } catch { continue; }
      if (r?.type === 'rep' && r.runId) {
        if (!repsByRun.has(r.runId)) repsByRun.set(r.runId, []);
        repsByRun.get(r.runId).push(r);
      }
    }
  }
  return repsByRun;
}

// Aggregates every rep record + oracle replay into per-(scenario,N) cells.
// filter(runId) lets callers restrict to a subset of runs.
export function buildCells(resultsDir, logsDir, filter = isRepFile) {
  const repsByRun = loadRepRecords(resultsDir, filter);
  const cells = new Map();
  const oracleTotals = {
    transitionViolations: 0, ownerMismatches: 0, fifoViolations: 0,
    compared: 0, rooms: 0, runsChecked: 0,
  };
  const aggFor = (scenario, n) => {
    const k = `${scenario}|${n}`;
    if (!cells.has(k)) {
      cells.set(k, {
        scenario, n, runs: 0, finished: 0, starved: 0,
        collisions: 0, transitionViolations: 0, fifoViolations: 0,
        waits: [], handoffs: [], idleGaps: [], recoveries: [], detections: [],
        reconnect: { kept: 0, requeued: 0, lost: 0 },
      });
    }
    return cells.get(k);
  };

  for (const [runId, reps] of repsByRun) {
    const ora = oracleReport(path.join(logsDir, `${runId}.jsonl`), reps);
    oracleTotals.runsChecked++;
    oracleTotals.rooms += ora.totals.rooms;
    oracleTotals.compared += ora.totals.compared;
    for (const rec of reps) {
      const c = aggFor(rec.scenario, rec.n);
      c.runs++;
      if (rec.finished) c.finished++;
      c.starved += rec.starved || 0;
      for (const s of rec.students || []) {
        if (s.requestToGrantMs != null) c.waits.push(s.requestToGrantMs);
        if (s.reconnectOutcome && c.reconnect[s.reconnectOutcome] != null) {
          c.reconnect[s.reconnectOutcome]++;
        }
      }
      for (const h of rec.handoffs || []) {
        // Disconnect-driven transfers (the previous holder dropped) are
        // floor-recovery events, not handoff latency — they are measured
        // once via disconnects[].floorRecoveryMs and never enter handoffMs.
        const drivenByDisconnect = (rec.disconnects || []).some(
          (d) => d.pid === h.prevPid && d.tDisconnect === h.prevRelease);
        if (h.kind === 'idle' && h.idleGapMs != null) c.idleGaps.push(h.idleGapMs);
        else if ((h.kind === 'contested' || h.kind == null)
          && h.handoffMs != null && !drivenByDisconnect) c.handoffs.push(h.handoffMs);
      }
      for (const d of rec.disconnects || []) {
        if (d.floorRecoveryMs != null) c.recoveries.push(d.floorRecoveryMs);
        const sd = (ora.perRoom[rec.roomId]?.disconnects || [])
          .find((x) => x.pid === d.pid);
        if (sd?.detectWall != null && d.tDisconnectWall != null) {
          c.detections.push(Math.round(sd.detectWall - d.tDisconnectWall));
        }
      }
      c.collisions += ora.perRoom[rec.roomId]?.ownerMismatches || 0;
      c.transitionViolations += ora.perRoom[rec.roomId]?.transitionViolations?.length || 0;
      c.fifoViolations += ora.perRoom[rec.roomId]?.fifoViolations || 0;
    }
    oracleTotals.transitionViolations += ora.totals.transitionViolations;
    oracleTotals.ownerMismatches += ora.totals.ownerMismatches;
    oracleTotals.fifoViolations += ora.totals.fifoViolations;
  }

  const rows = [...cells.values()].sort((a, b) =>
    a.scenario === b.scenario ? a.n - b.n : a.scenario.localeCompare(b.scenario));
  return { cells, rows, oracleTotals };
}

export const SUMMARY_HEADER = 'scenario,n,runs,collisions,oracleViolations,' +
  'fifoViolations,starvation,handoffMs_p50,handoffMs_p95,handoffMs_max,' +
  'idleGapMs_p50,idleGapMs_p95,' +
  'waitMs_p50,waitMs_p95,waitMs_max,floorRecoveryMs_p50,floorRecoveryMs_p95,reconnectKept';

export function cellCsvRow(c) {
  return [
    c.scenario, c.n, c.runs, c.collisions, c.transitionViolations,
    c.fifoViolations, c.starved,
    pctile(c.handoffs, 0.5), pctile(c.handoffs, 0.95), pctile(c.handoffs, 1),
    pctile(c.idleGaps, 0.5), pctile(c.idleGaps, 0.95),
    pctile(c.waits, 0.5), pctile(c.waits, 0.95), pctile(c.waits, 1),
    pctile(c.recoveries, 0.5), pctile(c.recoveries, 0.95),
    c.reconnect.kept || '',
  ].join(',');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const resultsDir = process.argv[2] || path.join(__dirname, 'results');
  const logsDir = process.argv[3] || path.resolve(__dirname, '../../logs/eval');
  const out = process.argv[4] || null;
  const { rows } = buildCells(resultsDir, logsDir);
  if (!rows.length) {
    console.error(`warning: no rep records found in ${path.resolve(resultsDir)}` +
      ` — expected floor_*.jsonl files`);
  }
  const csv = `${SUMMARY_HEADER}\n${rows.map(cellCsvRow).join('\n')}\n`;
  if (out) {
    fs.writeFileSync(out, csv);
    console.log(`wrote ${out}`);
  } else {
    process.stdout.write(csv);
  }
}
