// NCIP resume resolution — pure functions mapping the client message queue +
// the server's canonical interruption checkpoint to a resume plan.
// Unit-tested with node:test (plain ESM, no React).

// Lecture message ids are "<lectureId>_seg_<index>" (see Scene.handleStartClass).
const SEG_ID_RE = /^(.*)_seg_(\d+)$/;

export function lectureSegmentIndex(id) {
  const m = SEG_ID_RE.exec(id || '');
  return m ? Number(m[2]) : null;
}

// Returns a normalized checkpoint or null when the payload cannot be trusted.
// playbackOffsetMs is always >= 0; segmentIndex is a non-negative integer;
// lectureId must be a non-empty string.
export function validateCheckpoint(checkpoint) {
  if (!checkpoint || typeof checkpoint !== 'object') return null;
  const { lectureId, segmentIndex, playbackOffsetMs, language } = checkpoint;
  if (typeof lectureId !== 'string' || lectureId.length === 0) return null;
  if (!Number.isInteger(segmentIndex) || segmentIndex < 0) return null;
  if (!Number.isFinite(playbackOffsetMs) || playbackOffsetMs < 0) return null;
  return { lectureId, segmentIndex, playbackOffsetMs, language: language || null };
}

// Plan shapes:
//   { action: 'seek-head',       offsetSec }            — head is the checkpoint
//                                                       segment; seek the live
//                                                       audio element
//   { action: 'trim-and-seek',   fromIndex, offsetSec } — checkpoint segment is
//                                                       deeper in the queue
//                                                       (e.g. under a still-
//                                                       playing answer); drop
//                                                       everything before it
//   { action: 'local-fallback',  reason }               — resume the current
//                                                       head from its own
//                                                       resumeAt (legacy/local
//                                                       path or unmappable cp)
//   { action: 'abort',           reason }               — nothing safe to do
export function resolveResume(messages, checkpoint) {
  const msgs = Array.isArray(messages) ? messages : [];
  const head = msgs[0];

  if (checkpoint == null) {
    return { action: 'local-fallback', reason: null };
  }

  const cp = validateCheckpoint(checkpoint);
  if (!cp) {
    // Never silently restart — resume locally instead.
    return { action: 'local-fallback', reason: 'invalid-checkpoint', checkpoint };
  }
  if (cp.language) {
    // Positional resume is against the client's own queue; a language
    // mismatch is a caller-level warning, not a plan change.
  }

  const cpId = `${cp.lectureId}_seg_${cp.segmentIndex}`;
  const offsetSec = cp.playbackOffsetMs / 1000;

  if (head?.type === 'lecture' && head.id === cpId) {
    return { action: 'seek-head', messageId: cpId, offsetSec, checkpoint: cp };
  }

  const matchIndex = msgs.findIndex((m) => m.type === 'lecture' && m.id === cpId);
  if (matchIndex > 0) {
    return { action: 'trim-and-seek', fromIndex: matchIndex, messageId: cpId, offsetSec, checkpoint: cp };
  }

  // Checkpoint segment is not in this client's queue — either the client is
  // already ahead of it, or it never loaded that lecture. Do not restart.
  if (head?.type === 'lecture') {
    return {
      action: 'local-fallback',
      reason: 'checkpoint-unmapped',
      checkpointId: cpId,
      headId: head.id,
    };
  }
  return { action: 'abort', reason: 'no-lecture-message', checkpointId: cpId, headId: head?.id ?? null };
}
