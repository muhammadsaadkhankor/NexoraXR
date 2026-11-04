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

// Minimum cosine similarity source↔translation. Calibrated on
// gen_18b7cc52_L1: correct translations score 0.82–0.90, unrelated text
// ~0.74. 0.78 sits midway — semantic drift and wrong-topic output fail.
export const SEMANTIC_MIN = Number(process.env.TRANSLATE_SIM_MIN) || 0.78;

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
