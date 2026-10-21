// ProfessorAgent — V2.2 pedagogical stub-policy. Pure function, no LLM, no
// sockets, no TTS, no NCIP mutation. It reads LecturePlan + lectureProgress
// + manifest and returns a structured ProfessorAction; server.js is the sole
// executor and emitter.
//
// Pedagogy covered by deterministic policy:
//   fresh lecture            -> speak_dynamic(opening)
//   next topic starts        -> speak_dynamic(transition) once per topic
//   clarification question   -> speak_dynamic(reexplain) once per interaction
//   all topics taught        -> speak_dynamic(closing_recap), then end_lecture
import { getNextSegment } from './lecturePlan.mjs';
import { getTopicClarificationCount, hasTopicBeenReexplained } from './professorMemory.mjs';

export const ACTIONS = Object.freeze(['speak_segment', 'speak_dynamic', 'end_lecture']);
export const PURPOSES = Object.freeze(['opening', 'transition', 'reexplain', 'closing_recap', 'group_recap']);

// Validate a ProfessorAction against the plan + manifest it claims to use.
// Returns { ok: true } or { ok: false, error } — pure, no side effects.
export function validateAction(action, { plan, manifest }) {
  if (!action || typeof action !== 'object') return { ok: false, error: 'action not an object' };
  if (!ACTIONS.includes(action.action)) return { ok: false, error: `unknown action '${action.action}'` };
  const segIds = new Set((manifest?.segments || []).map((s) => s.id));
  const planSegs = plan ? new Set(plan.topics.flatMap((t) => t.segmentIds)) : null;
  const topicIds = plan ? new Set(plan.topics.map((t) => t.id)) : null;

  if (action.action === 'end_lecture') {
    // Terminal action must not smuggle teaching references.
    for (const k of ['segmentId', 'sourceSegmentIds', 'topicId', 'purpose']) {
      if (action[k] != null) return { ok: false, error: `end_lecture carries '${k}'` };
    }
    return { ok: true };
  }

  if (action.action === 'speak_segment') {
    if (!Number.isInteger(action.segmentId)) return { ok: false, error: 'speak_segment needs integer segmentId' };
    if (!segIds.has(action.segmentId)) return { ok: false, error: `segment ${action.segmentId} not in manifest` };
    if (planSegs && !planSegs.has(action.segmentId)) return { ok: false, error: `segment ${action.segmentId} not in plan` };
    if (action.topicId != null && topicIds && !topicIds.has(action.topicId)) {
      return { ok: false, error: `unknown topic '${action.topicId}'` };
    }
    return { ok: true };
  }

  // speak_dynamic
  if (!PURPOSES.includes(action.purpose)) return { ok: false, error: `speak_dynamic needs valid purpose` };
  if (!Array.isArray(action.sourceSegmentIds) || action.sourceSegmentIds.length === 0) {
    return { ok: false, error: 'speak_dynamic needs non-empty sourceSegmentIds' };
  }
  for (const sid of action.sourceSegmentIds) {
    if (!segIds.has(sid)) return { ok: false, error: `source segment ${sid} not in manifest` };
  }
  if (action.topicId != null && topicIds && !topicIds.has(action.topicId)) {
    return { ok: false, error: `unknown topic '${action.topicId}'` };
  }
  return { ok: true };
}

function topicOf(plan, segmentId) {
  return plan?.topics.find((t) => t.segmentIds.includes(segmentId)) || null;
}

function firstSegmentOfTopic(plan, topicId) {
  return plan?.topics.find((t) => t.id === topicId)?.segmentIds[0] ?? null;
}

// Latest un-reexplained clarification-flagged question on `topicId`.
function flaggedInteractionIndex(progress, topicId) {
  const history = progress?.interactionHistory;
  if (!Array.isArray(history)) return -1;
  for (let i = history.length - 1; i >= 0; i--) {
    const it = history[i];
    if (it.type === 'question' && it.topicId === topicId &&
        it.needsReexplanation === true && !it.reexplained) return i;
  }
  return -1;
}

export function decide({ plan, progress, memory, userMemories, manifest, roomLanguage, roomType, groupRecapMinUsers = 2 }) {
  const segments = manifest?.segments;
  if (!Array.isArray(segments) || segments.length === 0) {
    return { action: 'error', reason: 'empty_manifest' };
  }
  const p = progress || {};
  const current = p.currentSegmentId ?? null;
  const segIds = new Set(segments.map((s) => s.id));

  // ---- 1. Opening: fresh lecture -> dynamic opening before segment 0 ------
  if (current == null && !p.openingCompleted) {
    const first = segments[0];
    const t0 = plan ? topicOf(plan, first.id) : null;
    return {
      action: 'speak_dynamic',
      purpose: 'opening',
      topicId: t0?.id ?? null,
      sourceSegmentIds: [first.id],
      slidePage: t0?.slidePages?.[0] ?? first.slidePage ?? null,
      reason: 'fresh_lecture',
    };
  }

  // ---- 2. First prepared segment after the opening ------------------------
  if (current == null) {
    const first = segments[0];
    const t = plan ? topicOf(plan, first.id) : null;
    return segAction(first, t, 'lecture_start');
  }

  // ---- 2.5 Group recap for late joiners ------------------------------------
  // Deterministic policy: >= minUsers first-time late joiners are pending
  // with overlapping missed content; emit ONE shared recap grounded on the
  // common fully-missed segments plus the just-completed segment they joined
  // during. Private rooms never auto-recap — the host controls the flow.
  const pending = (p.groupRecap?.pendingLateJoiners || []).filter((j) => !j.covered);
  if (plan && roomType !== 'private' && pending.length >= (groupRecapMinUsers || 2) &&
      Number.isInteger(current)) {
    const common = pending.reduce(
      (acc, j) => acc.filter((id) => (j.fullyMissedSegmentIds || []).includes(id)),
      pending[0].fullyMissedSegmentIds || []);
    const sourceSegmentIds = [...new Set([...common, current])]
      .filter((id) => segIds.has(id));
    if (sourceSegmentIds.length) {
      return {
        action: 'speak_dynamic',
        purpose: 'group_recap',
        topicId: p.currentTopicId ?? null,
        sourceSegmentIds,
        joinedDuringSegmentId: current,
        participantIds: pending.map((j) => j.participantId),
        slidePage: topicOf(plan, current)?.slidePages?.[0] ?? null,
        reason: 'late_joiners',
      };
    }
  }

  // ---- 3. Re-explain -------------------------------------------------------
  // Deterministic policy (memory-aware): re-explain the CURRENT topic once if
  //   a) the classifier flagged a question on it, OR
  //   b) it accumulated >= 2 clarification questions,
  // and it hasn't already been re-explained (memory is the loop-breaker).
  if (plan && p.currentTopicId) {
    const t = topicOf(plan, current);
    if (t && !hasTopicBeenReexplained(memory, t.id)) {
      const idx = flaggedInteractionIndex(p, t.id);
      const thresholdHit = getTopicClarificationCount(memory, t.id) >= 2;
      if (idx >= 0 || thresholdHit) {
        return {
          action: 'speak_dynamic',
          purpose: 'reexplain',
          topicId: t.id,
          interactionIndex: idx >= 0 ? idx : undefined,
          sourceSegmentIds: t.segmentIds.filter((id) => segIds.has(id)),
          slidePage: t.slidePages?.[0] ?? null,
          reason: thresholdHit ? 'clarification_threshold' : 'clarification_requested',
        };
      }
    }
  }

  // ---- 4. Next unit --------------------------------------------------------
  const next = plan ? getNextSegment(plan, current) : manifestNext(segments, current);
  const inSeq = plan
    ? plan.topics.some((t) => t.segmentIds.includes(current))
    : segments.some((s) => s.id === current);

  if (next == null) {
    if (!inSeq) return { action: 'error', reason: 'invalid_current_segment' };
    // End of prepared content: closing recap once, then end.
    if (!p.closingCompleted) {
      const taught = (p.taughtTopicIds || [])
        .map((id) => plan?.topics.find((t) => t.id === id))
        .filter(Boolean);
      const sourceSegmentIds = (plan ? taught.flatMap((t) => t.segmentIds) : segments.map((s) => s.id))
        .filter((id) => segIds.has(id));
      const lastTopic = plan ? topicOf(plan, current) : null;
      return {
        action: 'speak_dynamic',
        purpose: 'closing_recap',
        topicId: lastTopic?.id ?? null,
        sourceSegmentIds: sourceSegmentIds.length ? sourceSegmentIds : [current],
        slidePage: lastTopic?.slidePages?.[0] ?? null,
        reason: 'all_topics_taught',
      };
    }
    return { action: 'end_lecture', reason: 'lecture_complete' };
  }

  // ---- 5. Topic transition -------------------------------------------------
  if (plan) {
    const nextTopic = topicOf(plan, next);
    const curTopic = topicOf(plan, current);
    if (nextTopic && curTopic?.id !== nextTopic.id &&
        !(p.completedTransitions || []).includes(nextTopic.id)) {
      return {
        action: 'speak_dynamic',
        purpose: 'transition',
        topicId: nextTopic.id,
        // Grounding: next topic's material (what we're moving INTO).
        sourceSegmentIds: nextTopic.segmentIds.filter((id) => segIds.has(id)),
        slidePage: nextTopic.slidePages?.[0] ?? null,
        reason: 'topic_change',
      };
    }
  }

  const seg = segments.find((s) => s.id === next);
  if (!seg) return { action: 'error', reason: 'plan_manifest_mismatch' };
  return segAction(seg, plan ? topicOf(plan, next) : null, 'next_segment');
}

function segAction(seg, topic, reason) {
  return {
    action: 'speak_segment',
    segmentId: seg.id,
    topicId: topic?.id ?? null,
    slidePage: topic?.slidePages?.[0] ?? seg.slidePage ?? null,
    reason,
  };
}

function manifestNext(segments, current) {
  const idx = segments.findIndex((s) => s.id === current);
  if (idx < 0) return null;
  return segments[idx + 1]?.id ?? null;
}
