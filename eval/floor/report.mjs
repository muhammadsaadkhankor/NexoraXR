// Terminal report for the floor benchmark — aggregates eval/floor/results
// JSONL records into an ASCII table per (scenario, N) cell.
//
//   node eval/floor/report.mjs                 # all files in results/
//   node eval/floor/report.mjs results/x.jsonl # specific file(s)
//   node eval/floor/report.mjs -v              # include per-rep rows
//
// Also imported by run.mjs to print the same table when a matrix finishes.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.join(__dirname, 'results');

const pct = (xs, p) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)];
};
const median = (xs) => pct(xs, 0.5);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const fmt = (v) => (v == null ? '-' : `${Math.round(v)}`);

export function loadRecords(files) {
  const out = [];
  for (const f of files) {
    for (const line of fs.readFileSync(f, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* skip corrupt line */ }
    }
  }
  return out;
}

export function resultFiles(dir = RESULTS_DIR) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .sort()
    .map((f) => path.join(dir, f));
}

// Roll rep records up to one row per (scenario, N).
export function summarize(records) {
  const cells = new Map();
  for (const r of records || []) {
    if (r?.type !== 'rep') continue;
    const key = `${r.scenario}|${r.n}`;
    const c = cells.get(key) || {
      scenario: r.scenario, n: r.n, reps: 0, finished: 0, errors: 0,
      students: 0, granted: 0, answered: 0, floorErrors: 0,
      extraRequests: 0, reqToGrant: [], answer: [], drain: [],
    };
    c.reps++;
    if (r.finished) c.finished++;
    if (r.error) c.errors++;
    for (const s of r.students || []) {
      c.students++;
      if (s.tGrant != null) c.granted++;
      if (s.tAnswerStart != null) c.answered++;
      c.extraRequests += Math.max(0, (s.requestsSent || 1) - 1);
      c.floorErrors += (s.floorErrors || []).length;
      if (s.requestToGrantMs != null) c.reqToGrant.push(s.requestToGrantMs);
      if (s.answerMs != null) c.answer.push(s.answerMs);
    }
    if (r.durationMs != null) c.drain.push(r.durationMs);
    cells.set(key, c);
  }
  return [...cells.values()].sort((a, b) =>
    a.scenario === b.scenario ? a.n - b.n : a.scenario.localeCompare(b.scenario));
}

function table(headers, rows, rightAlign = []) {
  if (!rows.length) return '(no records)';
  const w = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (cells) => cells
    .map((c, i) => (rightAlign.includes(i) ? String(c).padStart(w[i]) : String(c).padEnd(w[i])))
    .join('  ');
  return [
    line(headers),
    w.map((x) => '─'.repeat(x)).join('  '),
    ...rows.map(line),
  ].join('\n');
}

// Aggregate table: one row per (scenario, N) cell. All latencies in ms.
export function formatSummary(cells) {
  return table(
    ['scenario', 'n', 'reps', 'grants', 'req→grant med', 'p95', 'max',
      'answer med', 'drain mean', 'errors'],
    cells.map((c) => {
      const g = c.reqToGrant;
      return [
        c.scenario, c.n, `${c.finished}/${c.reps}`,
        `${c.granted}/${c.students}`,
        fmt(median(g)), fmt(pct(g, 0.95)), fmt(pct(g, 1)),
        fmt(median(c.answer)), fmt(mean(c.drain)),
        c.errors + c.floorErrors || '-',
      ];
    }),
    [1, 2, 3, 4, 5, 6, 7, 8, 9],
  );
}

// Per-rep detail rows (verbose mode).
export function formatReps(records) {
  const reps = (records || []).filter((r) => r?.type === 'rep')
    .sort((a, b) => `${a.scenario}${a.n}`.localeCompare(`${b.scenario}${b.n}`) || a.rep - b.rep);
  return table(
    ['scenario', 'n', 'rep', 'seed', 'grants', 'drain ms', 'result'],
    reps.map((r) => [
      r.scenario, r.n, r.rep, r.seed,
      r.students ? `${r.students.filter((s) => s.tGrant != null).length}/${r.students.length}` : '-',
      fmt(r.durationMs),
      r.error ? `ERR ${r.error}` : r.finished ? 'ok' : 'timeout',
    ]),
    [1, 2, 4, 5],
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const verbose = args.includes('-v') || args.includes('--verbose');
  const files = args.filter((a) => !a.startsWith('-'));
  const targets = files.length ? files : resultFiles();
  if (!targets.length) {
    console.error(`no result files in ${RESULTS_DIR} — run eval/floor/run.mjs first`);
    process.exit(1);
  }
  const records = loadRecords(targets);
  console.log(formatSummary(summarize(records)));
  if (verbose) console.log(`\n${formatReps(records)}`);
}
