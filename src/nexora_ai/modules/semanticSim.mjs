// Semantic similarity gate for translations: scores (source, candidate)
// pairs with intfloat/multilingual-e5-small via a Python subprocess
// (transformers env). One model load per call — callers should batch all
// segments of a language into a single scorePairs() call. Failure of the
// checker itself is non-fatal and returns null (callers decide policy).

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PY_SCRIPT = path.join(__dirname, '..', 'scripts', 'e5_similarity.py');
const PY_BIN = process.env.SEMANTIC_PYTHON
  || `${process.env.HOME}/anaconda3/envs/voxcpm/bin/python`;
const TIMEOUT_MS = Number(process.env.SEMANTIC_TIMEOUT_MS) || 300_000;

// Minimum cosine similarity source↔translation. Calibrated 2026-11 on every
// accepted baked translation in lecture_cache (n=63: min 0.759, p5 0.787,
// median 0.853) against cross-lecture mismatches (median 0.770, max 0.837).
// The distributions overlap — e5-small cannot separate a same-domain
// mismatch from a real translation — so the gate only catches GROSS drift
// (wrong topic / unrelated text, <0.70), never borderline style. 0.74 sits
// below the observed good minimum with margin; the old 0.78 rejected
// verified-good Arabic output.
export const SEMANTIC_MIN = Number(process.env.TRANSLATE_SIM_MIN) || 0.74;

export async function scorePairs(pairs) {
  if (!pairs.length) return [];
  return new Promise((resolve) => {
    const child = spawn(PY_BIN, [PY_SCRIPT]);
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      console.warn('[semantic-sim] timed out — check skipped');
      resolve(null);
    }, TIMEOUT_MS);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', (code) => {
      clearTimeout(timer);
      try {
        const scores = JSON.parse(out.trim());
        if (Array.isArray(scores) && scores.length === pairs.length) resolve(scores);
        else resolve(null);
      } catch {
        console.warn(`[semantic-sim] failed (${code}): ${err.slice(-200)}`);
        resolve(null);
      }
    });
    child.stdin.end(JSON.stringify({ pairs }));
  });
}
