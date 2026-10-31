import { test } from 'node:test';
import assert from 'node:assert/strict';
import { audioOnTarget, AUDIO_MIN_S, AUDIO_MAX_S } from './bake.mjs';
import { validateDraftScript } from './drafts.mjs';

// Duration band — the regression: a 13.4m reviewed lecture was rejected by
// the old 10-minute ceiling and its validation poisoned.
test('audio duration band accepts up to 20 minutes by default', () => {
  assert.equal(AUDIO_MAX_S, 1200);
  assert.equal(audioOnTarget(13.4 * 60 * 1000), true, '13.4m passes');
  assert.equal(audioOnTarget(20 * 60 * 1000), true, 'exactly 20m passes');
  assert.equal(audioOnTarget(21 * 60 * 1000), false, '21m still rejected');
  assert.equal(audioOnTarget(3 * 60 * 1000), false, `${AUDIO_MIN_S}s floor holds`);
});

// Draft gate — generated scripts must never exceed what approval accepts.
test('draft word gate keeps a 1450-word script approvable', () => {
  const seg = (n) => ({ text: Array(n).fill('word').join(' ') });
  const under = validateDraftScript([seg(1200), seg(250)]);
  assert.equal(under.ok, true, JSON.stringify(under.problems));
  const over = validateDraftScript([seg(1200), seg(400)]);
  assert.equal(over.ok, false);
  assert.ok(over.problems.some((p) => p.includes('too long')));
});
