// LecturePlan loader — pure functions, no sockets, no I/O beyond fs.
// lecture_plan.json is baked offline by profbrain/build_plan.py:
//   { lectureId, title, topics: [{id, title, segmentIds, slidePages}] }
// A plan is an OPTIONAL index over the runtime segment manifest — a lecture
// without a plan still plays (agent falls back to manifest order, topicId null).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROFBRAIN_DIR = path.join(__dirname, '..', '..', '..', 'profbrain', 'lectures');

const cache = new Map(); // lectureId -> plan | null  (null = known-missing)

function validatePlan(plan, lectureId) {
  if (!plan || typeof plan !== 'object') return 'plan is not an object';
  if (plan.lectureId !== lectureId) return `lectureId mismatch: ${plan.lectureId}`;
  if (typeof plan.title !== 'string' || !plan.title) return 'missing title';
  if (!Array.isArray(plan.topics) || plan.topics.length === 0) return 'topics missing/empty';
  const topicIds = new Set();
  const seenSegments = new Set();
  for (const [i, t] of plan.topics.entries()) {
    if (!t || typeof t !== 'object') return `topic ${i} is not an object`;
    if (typeof t.id !== 'string' || !t.id) return `topic ${i} missing id`;
    if (topicIds.has(t.id)) return `duplicate topic id '${t.id}'`;
    topicIds.add(t.id);
    if (typeof t.title !== 'string') return `topic ${i} missing title`;
    if (!Array.isArray(t.segmentIds) || t.segmentIds.length === 0) {
      return `topic ${i} has no segmentIds`;
    }
    for (const sid of t.segmentIds) {
      if (!Number.isInteger(sid) || sid < 0) return `topic ${i} bad segmentId ${sid}`;
      if (seenSegments.has(sid)) return `segment ${sid} in more than one topic`;
      seenSegments.add(sid);
    }
    if (!Array.isArray(t.slidePages)) return `topic ${i} missing slidePages`;
    for (const p of t.slidePages) {
      if (!Number.isInteger(p) || p < 1) return `topic ${i} bad slidePage ${p}`;
    }
  }
  return null;
}

// Returns the validated plan, or null when the file is absent. Throws on a
// malformed plan — a corrupt plan must never be silently treated as "none".
export function getLecturePlan(lectureId) {
  if (cache.has(lectureId)) return cache.get(lectureId);
  const planPath = path.join(PROFBRAIN_DIR, lectureId, 'lecture_plan.json');
  if (!fs.existsSync(planPath)) {
    cache.set(lectureId, null);
    return null;
  }
  let plan;
  try {
    plan = JSON.parse(fs.readFileSync(planPath, 'utf-8'));
  } catch (err) {
    throw new Error(`lecture_plan.json for ${lectureId} is not valid JSON: ${err.message}`);
  }
  const err = validatePlan(plan, lectureId);
  if (err) throw new Error(`lecture_plan.json for ${lectureId} invalid: ${err}`);
  // Index segment -> topic once for O(1) lookups.
  plan._topicBySegment = new Map();
  for (const t of plan.topics) for (const sid of t.segmentIds) plan._topicBySegment.set(sid, t);
  cache.set(lectureId, plan);
  return plan;
}

export function getTopicForSegment(lectureId, segmentId) {
  const plan = getLecturePlan(lectureId);
  return plan?._topicBySegment.get(segmentId) || null;
}

// Next segment after currentSegmentId, walking the plan's segment order.
// currentSegmentId === null returns the plan's first segment. An unknown
// currentSegmentId returns null (caller decides how to fail).
export function getNextSegment(plan, currentSegmentId) {
  if (!plan) return null;
  const order = plan.topics.flatMap((t) => t.segmentIds);
  if (currentSegmentId == null) return order[0] ?? null;
  const idx = order.indexOf(currentSegmentId);
  if (idx < 0) return null;
  return order[idx + 1] ?? null;
}

// Test hook — drop cached plans between cases.
export function _clearPlanCache() {
  cache.clear();
}
