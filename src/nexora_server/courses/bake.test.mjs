import { test } from 'node:test';
import assert from 'node:assert/strict';
import { audioOnTarget, DUR_RATIO_MIN, DUR_RATIO_MAX } from './bake.mjs';
import { durationRatioBand } from '../../shared/languages.mjs';
import { validateDraftScript } from './drafts.mjs';

// Whole-lecture duration is INFORMATIONAL only — length follows the content
// and never fails a build. audioOnTarget remains as the reference-band flag
// shown to the reviewer.
test('audio reference band is informational, not a gate', () => {
  assert.equal(typeof audioOnTarget(13.4 * 60 * 1000), 'boolean');
  assert.equal(audioOnTarget(3 * 60 * 1000), false, 'below band — reported, not failed');
  assert.equal(audioOnTarget(25 * 60 * 1000), false, 'above band — reported, not failed');
});

// Per-segment safety band: <0.5x is likely truncated, >3x is likely a TTS
// loop — everything else passes, per language.
test('segment duration band is 0.5x–3x for every language', () => {
  assert.equal(DUR_RATIO_MIN, 0.5);
  assert.equal(DUR_RATIO_MAX, 3.0);
  for (const lang of ['ar', 'fr', 'de', 'es', 'zh']) {
    const b = durationRatioBand(lang);
    assert.equal(b.min, 0.5, `${lang} min`);
    assert.equal(b.max, 3.0, `${lang} max`);
  }
});

// Draft gate — no word-count limits: only structural breakage blocks.
test('draft gate accepts any length, rejects only empty scripts', () => {
  const seg = (n) => ({ text: Array(n).fill('word').join(' ') });
  assert.equal(validateDraftScript([seg(40)]).ok, true, 'short script is fine');
  assert.equal(validateDraftScript([seg(1200), seg(900)]).ok, true, 'long script is fine');
  assert.equal(validateDraftScript([]).ok, false);
  assert.equal(validateDraftScript([{ text: '  ' }]).ok, false);
});
