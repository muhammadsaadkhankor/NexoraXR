import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, validateAction } from './professorAgent.mjs';
import { getLecturePlan, _clearPlanCache } from './lecturePlan.mjs';

const MANIFEST = (n) => ({
  segments: Array.from({ length: n }, (_, i) => ({ id: i, text: `seg ${i}` })),
});

// Progress record as NcipRoom produces it.
const PROGRESS = (over = {}) => ({
  lectureId: 'Lecture_X', currentTopicId: null, currentSegmentId: null,
  taughtTopicIds: [], openingCompleted: false, completedTransitions: [],
  closingCompleted: false, interactionHistory: [], ...over,
});

const PLAN = {
  lectureId: 'Lecture_X', title: 'X',
  topics: [
    { id: 't0', title: 'A', segmentIds: [0, 1], slidePages: [1] },
    { id: 't1', title: 'B', segmentIds: [2, 3], slidePages: [5] },
    { id: 't2', title: 'C', segmentIds: [4], slidePages: [9] },
  ],
};

// ---------- action contract (validateAction) ----------

test('valid actions accepted', () => {
  const m = MANIFEST(5);
  assert.equal(validateAction({ action: 'speak_segment', segmentId: 0, topicId: 't0' }, { plan: PLAN, manifest: m }).ok, true);
  assert.equal(validateAction({ action: 'speak_dynamic', purpose: 'opening', sourceSegmentIds: [0] }, { plan: PLAN, manifest: m }).ok, true);
  assert.equal(validateAction({ action: 'end_lecture' }, { plan: PLAN, manifest: m }).ok, true);
});

test('unknown action rejected', () => {
  assert.equal(validateAction({ action: 'fly' }, { manifest: MANIFEST(2) }).ok, false);
});

test('speak_segment requires valid segmentId', () => {
  const m = MANIFEST(5);
  assert.equal(validateAction({ action: 'speak_segment' }, { manifest: m }).ok, false);
  assert.equal(validateAction({ action: 'speak_segment', segmentId: 99 }, { manifest: m }).ok, false);
  assert.equal(validateAction({ action: 'speak_segment', segmentId: 3 }, { plan: PLAN, manifest: m }).ok, true); // 3 is in plan (t1)
});

test('speak_segment segmentId must be in plan when plan exists', () => {
  const m = MANIFEST(10);
  // segment 9 exists in manifest but not in PLAN -> reject
  assert.equal(validateAction({ action: 'speak_segment', segmentId: 9 }, { plan: PLAN, manifest: m }).ok, false);
});

test('speak_dynamic requires purpose + grounding refs', () => {
  const m = MANIFEST(5);
  assert.equal(validateAction({ action: 'speak_dynamic', purpose: 'opening' }, { manifest: m }).ok, false);
  assert.equal(validateAction({ action: 'speak_dynamic', purpose: 'bogus', sourceSegmentIds: [0] }, { manifest: m }).ok, false);
  assert.equal(validateAction({ action: 'speak_dynamic', purpose: 'transition', sourceSegmentIds: [42] }, { manifest: m }).ok, false);
});

test('end_lecture carries no teaching refs', () => {
  assert.equal(validateAction({ action: 'end_lecture', segmentId: 1 }, { manifest: MANIFEST(3) }).ok, false);
  assert.equal(validateAction({ action: 'end_lecture', topicId: 't0' }, { manifest: MANIFEST(3) }).ok, false);
});

// ---------- decide() sequences (no plan) ----------

test('fresh lecture -> opening (once), then segment 0', () => {
  const m = MANIFEST(3);
  const d1 = decide({ plan: null, progress: PROGRESS(), manifest: m });
  assert.equal(d1.action, 'speak_dynamic');
  assert.equal(d1.purpose, 'opening');
  assert.deepEqual(d1.sourceSegmentIds, [0]);
  const d2 = decide({ plan: null, progress: PROGRESS({ openingCompleted: true }), manifest: m });
  assert.deepEqual({ action: d2.action, segmentId: d2.segmentId }, { action: 'speak_segment', segmentId: 0 });
});

test('plan-less manifest sequences segments then closing then end', () => {
  const m = MANIFEST(2);
  const p = PROGRESS({ openingCompleted: true, currentSegmentId: 1, currentTopicId: null });
  const close = decide({ plan: null, progress: p, manifest: m });
  assert.equal(close.action, 'speak_dynamic');
  assert.equal(close.purpose, 'closing_recap');
  const end = decide({ plan: null, progress: PROGRESS({ ...p, closingCompleted: true }), manifest: m });
  assert.equal(end.action, 'end_lecture');
});

test('invalid current segment -> safe failure', () => {
  const d = decide({ plan: null, progress: PROGRESS({ openingCompleted: true, currentSegmentId: 99 }), manifest: MANIFEST(5) });
  // 99 isn't in seq: with a pending closing? invalid_current_segment
  assert.equal(d.action, 'error');
  assert.equal(d.reason, 'invalid_current_segment');
});

// ---------- decide() with Lecture_1 plan ----------

test('with plan: opening -> segments with one transition per topic -> closing -> end', () => {
  _clearPlanCache();
  const plan = getLecturePlan('Lecture_1');
  const manifest = MANIFEST(10);
  let p = PROGRESS();
  const seq = [];
  for (let i = 0; i < 40; i++) {
    const a = decide({ plan, progress: p, manifest });
    seq.push(a.action === 'speak_dynamic' ? `${a.purpose}`
      : a.action === 'end_lecture' ? 'end_lecture'
      : `${a.action}:${a.segmentId}`);
    if (a.action === 'end_lecture') break;
    // simulate orchestrator commit
    if (a.action === 'speak_segment') {
      p.currentSegmentId = a.segmentId; p.currentTopicId = a.topicId;
      if (a.topicId && !p.taughtTopicIds.includes(a.topicId)) p.taughtTopicIds.push(a.topicId);
    } else if (a.action === 'speak_dynamic') {
      if (a.purpose === 'opening') p.openingCompleted = true;
      if (a.purpose === 'closing_recap') p.closingCompleted = true;
      if (a.purpose === 'transition' && !p.completedTransitions.includes(a.topicId)) p.completedTransitions.push(a.topicId);
    }
  }
  // opening once, 10 segments, 9 transitions (t1..t9), closing once, end
  assert.equal(seq[0], 'opening');
  assert.equal(seq.filter((s) => s === 'opening').length, 1);
  assert.equal(seq.filter((s) => s === 'transition').length, 9);
  assert.equal(seq.filter((s) => s === 'closing_recap').length, 1);
  assert.deepEqual(seq.filter((s) => s.startsWith('speak_segment')),
    [...Array(10).keys()].map((i) => `speak_segment:${i}`));
  assert.equal(seq.at(-1), 'end_lecture');
});

test('same-topic advance emits no transition', () => {
  _clearPlanCache();
  const plan = getLecturePlan('Lecture_1'); // all topics are single-segment here
  const m = MANIFEST(10);
  // use synthetic plan with multi-segment topic
  const p2 = PLAN;
  const prog = PROGRESS({ openingCompleted: true, currentSegmentId: 0, currentTopicId: 't0', taughtTopicIds: ['t0'] });
  const d = decide({ plan: p2, progress: prog, manifest: MANIFEST(5) });
  assert.equal(d.action, 'speak_segment'); // 0->1 same topic, no transition
  assert.equal(d.segmentId, 1);
});

test('clarification flagged on current topic -> reexplain once', () => {
  const plan = PLAN;
  const m = MANIFEST(5);
  const prog = PROGRESS({
    openingCompleted: true, currentSegmentId: 2, currentTopicId: 't1', taughtTopicIds: ['t0', 't1'],
    interactionHistory: [{ type: 'question', topicId: 't1', segmentId: 2, question: 'what?', needsReexplanation: true, reexplained: false }],
  });
  const d = decide({ plan, progress: prog, manifest: m });
  assert.equal(d.action, 'speak_dynamic');
  assert.equal(d.purpose, 'reexplain');
  assert.equal(d.topicId, 't1');
  assert.deepEqual(d.sourceSegmentIds, [2, 3]);
  // after the interaction is marked reexplained, progression resumes normally
  prog.interactionHistory[0].reexplained = true;
  const d2 = decide({ plan, progress: prog, manifest: m });
  assert.equal(d2.action, 'speak_segment'); // seg 3 is still topic t1
  assert.equal(d2.segmentId, 3);
  // finishing t1 then yields exactly one transition into t2
  prog.currentSegmentId = 3;
  const d3 = decide({ plan, progress: prog, manifest: m });
  assert.equal(d3.purpose, 'transition');
  assert.equal(d3.topicId, 't2');
});

test('non-clarification question does not trigger reexplain', () => {
  const prog = PROGRESS({
    openingCompleted: true, currentSegmentId: 2, currentTopicId: 't1', taughtTopicIds: ['t0', 't1'],
    interactionHistory: [{ type: 'question', topicId: 't1', segmentId: 2, question: 'q', needsReexplanation: false, reexplained: false }],
  });
  const d = decide({ plan: PLAN, progress: prog, manifest: MANIFEST(5) });
  assert.notEqual(d.purpose, 'reexplain');
});

test('deterministic across repeated calls', () => {
  const args = { plan: PLAN, progress: PROGRESS({ openingCompleted: true, currentSegmentId: 0, currentTopicId: 't0' }), manifest: MANIFEST(5) };
  assert.deepEqual(decide(args), decide(args));
});

// ---------- memory-based re-explanation rule (V2.3) ----------

const mem = (clarifications = {}, reexplained = []) => ({
  lectureId: 'Lecture_X', topicsTaught: [], questions: [],
  reexplainedTopics: reexplained, clarificationCountByTopic: clarifications,
  lastInteraction: null,
});

test('clarification count 0/1 -> normal continuation', () => {
  const m = MANIFEST(5);
  for (const count of [0, 1]) {
    const prog = PROGRESS({
      openingCompleted: true, currentSegmentId: 2, currentTopicId: 't1', taughtTopicIds: ['t0', 't1'],
    });
    const d = decide({ plan: PLAN, progress: prog, memory: mem({ t1: count }), manifest: m });
    assert.equal(d.purpose !== 'reexplain', true);
    assert.equal(d.action, 'speak_segment'); // seg 3, same topic
  }
});

test('clarification count >= 2 and not re-explained -> one re-explanation', () => {
  const prog = PROGRESS({
    openingCompleted: true, currentSegmentId: 2, currentTopicId: 't1', taughtTopicIds: ['t0', 't1'],
  });
  const d = decide({ plan: PLAN, progress: prog, memory: mem({ t1: 2 }), manifest: MANIFEST(5) });
  assert.equal(d.action, 'speak_dynamic');
  assert.equal(d.purpose, 'reexplain');
  assert.equal(d.topicId, 't1');
  assert.equal(d.reason, 'clarification_threshold');
  assert.deepEqual(d.sourceSegmentIds, [2, 3]);
});

test('count 3 but already re-explained -> continue, no loop', () => {
  const prog = PROGRESS({
    openingCompleted: true, currentSegmentId: 2, currentTopicId: 't1', taughtTopicIds: ['t0', 't1'],
  });
  const d = decide({ plan: PLAN, progress: prog, memory: mem({ t1: 3 }, ['t1']), manifest: MANIFEST(5) });
  assert.notEqual(d.purpose, 'reexplain');
  assert.equal(d.action, 'speak_segment');
});

test('missing memory degrades safely to interaction-flag rule only', () => {
  const prog = PROGRESS({
    openingCompleted: true, currentSegmentId: 2, currentTopicId: 't1', taughtTopicIds: ['t0', 't1'],
  });
  // no flagged interaction, no memory -> plain continuation
  assert.equal(decide({ plan: PLAN, progress: prog, memory: null, manifest: MANIFEST(5) }).action, 'speak_segment');
});

// ---------- group recap for late joiners (V2.4) ----------

const joiner = (participantId, joinedDuring, missed) => ({
  participantId, joinedAtSegmentId: joinedDuring, joinedDuringSegmentId: joinedDuring,
  fullyMissedSegmentIds: missed, joinedAt: 0,
});
const withJoiners = (pending, extra = {}) => ({
  openingCompleted: true, currentSegmentId: 1, currentTopicId: 't0', taughtTopicIds: ['t0'],
  groupRecap: { pendingLateJoiners: pending, completedRecaps: [] },
  ...extra,
});

test('one late joiner -> no group recap', () => {
  const prog = PROGRESS(withJoiners([joiner('B', 1, [0])]));
  const d = decide({ plan: PLAN, progress: prog, manifest: MANIFEST(5), roomType: 'public', groupRecapMinUsers: 2 });
  assert.notEqual(d.purpose, 'group_recap');
});

test('two late joiners in same segment -> one group recap', () => {
  const prog = PROGRESS(withJoiners([joiner('B', 1, [0]), joiner('C', 1, [0])]));
  const d = decide({ plan: PLAN, progress: prog, manifest: MANIFEST(5), roomType: 'public', groupRecapMinUsers: 2 });
  assert.equal(d.action, 'speak_dynamic');
  assert.equal(d.purpose, 'group_recap');
  assert.deepEqual(d.sourceSegmentIds, [0, 1]); // common missed 0 + just-finished seg 1
  assert.equal(d.joinedDuringSegmentId, 1);
  assert.deepEqual(d.participantIds.sort(), ['B', 'C']);
  assert.equal(d.reason, 'late_joiners');
});

test('different join times -> common missed range only', () => {
  // B joined during seg 2 (missed 0,1), C during seg 3 (missed 0,1,2);
  // current segment just completed = 3.
  const prog = PROGRESS(withJoiners([joiner('B', 2, [0, 1]), joiner('C', 3, [0, 1, 2])],
    { currentSegmentId: 3, currentTopicId: 't1', taughtTopicIds: ['t0', 't1'] }));
  const d = decide({ plan: PLAN, progress: prog, manifest: MANIFEST(5), roomType: 'public', groupRecapMinUsers: 2 });
  assert.equal(d.purpose, 'group_recap');
  assert.deepEqual(d.sourceSegmentIds, [0, 1, 3]); // common missed [0,1] + key point of seg 3
  assert.equal(d.joinedDuringSegmentId, 3);
});

test('private room -> no group recap (host controls flow)', () => {
  const prog = PROGRESS(withJoiners([joiner('B', 1, [0]), joiner('C', 1, [0])]));
  const d = decide({ plan: PLAN, progress: prog, manifest: MANIFEST(5), roomType: 'private', groupRecapMinUsers: 2 });
  assert.notEqual(d.purpose, 'group_recap');
});

test('no pending joiners (or all resolved) -> no recap repeat', () => {
  const prog = PROGRESS(withJoiners([], {
    groupRecap: { pendingLateJoiners: [], completedRecaps: [{ participantIds: ['B', 'C'] }] },
  }));
  const d = decide({ plan: PLAN, progress: prog, manifest: MANIFEST(5), roomType: 'public', groupRecapMinUsers: 2 });
  assert.notEqual(d.purpose, 'group_recap');
});

test('NXR_GROUP_RECAP_MIN_USERS configurable via arg', () => {
  const prog = PROGRESS(withJoiners([joiner('B', 1, [0]), joiner('C', 1, [0]), joiner('D', 1, [0])]));
  const d = decide({ plan: PLAN, progress: prog, manifest: MANIFEST(5), roomType: 'public', groupRecapMinUsers: 4 });
  assert.notEqual(d.purpose, 'group_recap');
});

test('group_recap action validates', () => {
  const a = { action: 'speak_dynamic', purpose: 'group_recap', topicId: 't0',
    sourceSegmentIds: [0, 1], joinedDuringSegmentId: 1, participantIds: ['B', 'C'] };
  assert.equal(validateAction(a, { plan: PLAN, manifest: MANIFEST(5) }).ok, true);
});
