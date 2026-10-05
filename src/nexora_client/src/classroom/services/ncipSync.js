// NCIP Slice 2 — client-side version tracking and snapshot recovery planning.
// Pure functions only (no React, no DOM) so they can be unit-tested with
// node:test alongside ncipResume.
import { lectureSegmentIndex, validateCheckpoint } from './ncipResume.js';

// Classify an incoming authoritative NCIP event against the last applied
// stateVersion:
//   'stale' — event is older than what we applied; must be ignored
//   'apply' — same transition (multi-event) or the next version; apply normally
//   'gap'   — versions were missed; do NOT apply, request session.sync instead
// Unversioned events (v == null) are non-NCIP or legacy and always 'apply'.
//
// Note on the equal case: one authoritative transition may emit several events
// that all carry the SAME stateVersion (e.g. floor-state + pause-for-floor from
// a single floor grant). Treating '==' as stale would drop the second event, so
// same-version events are always applied — every NCIP handler is idempotent.
export function classifyEvent(lastApplied, version) {
  if (version == null || !Number.isFinite(version)) return 'apply';
  if (lastApplied == null || lastApplied < 0) {
    // Nothing applied yet — only the snapshot establishes the baseline, so any
    // versioned event before it means we missed state; request a sync.
    return 'gap';
  }
  if (version < lastApplied) return 'stale';
  if (version === lastApplied || version === lastApplied + 1) return 'apply';
  return 'gap';
}

// Normalize the authoritative lecture position embedded in a snapshot into an
// NCIP checkpoint, or null when the snapshot carries no usable position.
export function snapshotCheckpoint(lecture) {
  if (!lecture || lecture.active !== true) return null;
  return validateCheckpoint({
    lectureId: lecture.lectureId,
    segmentIndex: lecture.segmentIndex,
    playbackOffsetMs: lecture.playbackOffsetMs ?? 0,
    language: lecture.language || 'en',
  });
}

// Decide how a client must converge its lecture playback to the snapshot:
//   { action: 'none' }               — no active lecture to recover
//   { action: 'resume', checkpoint } — checkpoint segment is already in the
//                                      local queue; resume via resolveResume
//   { action: 'reload', checkpoint } — segment not loaded locally; the caller
//                                      must fetch segments via the lecture API,
//                                      rebuild the queue from segmentIndex and
//                                      seek to playbackOffsetMs. Never 0.
export function planLectureRecovery(snapshot, messages) {
  const cp = snapshotCheckpoint(snapshot?.lecture);
  if (!cp) return { action: 'none' };
  const segId = `${cp.lectureId}_seg_${cp.segmentIndex}`;
  const hasSegment = (messages || []).some(
    (m) => m.type === 'lecture' && m.id === segId
  );
  return hasSegment
    ? { action: 'resume', checkpoint: cp }
    : { action: 'reload', checkpoint: cp };
}

// Decide whether a (re)joining client must start playing the in-flight floor
// answer mid-way through. Elapsed time is computed on the SERVER clock:
// snapshot.serverNow and currentAnswer.startedAt come from the same
// Date.now(), so no client/server skew is involved.
//
// Returns:
//   { action: 'none' }                      — professor is not ANSWERING
//   { action: 'skip', reason }              — answer already over; do not replay
//   { action: 'play', message, seekSec, elapsedMs } — prepend this message;
//                                             Avatar seeks via resumeAt
export function planAnswerRecovery(snapshot) {
  if (snapshot?.professor?.status !== 'ANSWERING') return { action: 'none' };
  const a = snapshot.currentAnswer;
  if (!a || !(a.audioUrl || a.audio)) return { action: 'skip', reason: 'no-answer-payload' };
  const serverNow = Number.isFinite(snapshot.serverNow) ? snapshot.serverNow : Date.now();
  const elapsedMs = Math.max(0, serverNow - a.startedAt);
  if (Number.isFinite(a.durationMs) && elapsedMs >= a.durationMs) {
    return { action: 'skip', reason: 'answer-finished', elapsedMs };
  }
  const seekSec = elapsedMs / 1000;
  return {
    action: 'play',
    elapsedMs,
    seekSec,
    message: {
      id: a.id,
      text: a.text ?? '',
      audioUrl: a.audioUrl ?? null,
      audio: a.audio ?? null,
      lipsync: a.lipsync ?? null,
      animation: a.animation ?? undefined,
      facialExpression: a.facialExpression ?? undefined,
      floorAnswer: true,
      fromRemote: true,
      resumeAt: seekSec,
    },
  };
}

// True when a snapshot is older than the client's applied version — a delayed
// snapshot must never roll a converged client backward.
export function snapshotIsStale(lastApplied, snapshot) {
  const v = snapshot?.stateVersion;
  return Number.isFinite(v) && Number.isFinite(lastApplied) && lastApplied >= 0
    ? v < lastApplied
    : false;
}

// Map a snapshot floor payload (holders/queues are {userId,name} objects like
// floor-state) into the UI shape Scene already consumes.
export function snapshotFloor(snapshot) {
  const f = snapshot?.floor || {};
  return {
    floorQueue: Array.isArray(f.queue) ? f.queue : [],
    activeSpeaker: f.holder || null,
  };
}

// NCIP Slice 3: authoritative room language carried by the snapshot.
export function snapshotLanguage(snapshot) {
  return snapshot?.language?.roomLanguage || null;
}

// Language-switch rebuild plan. Returns the segment to rebuild from and
// whether the queue head is the playing lecture segment. Prefers the local
// queue position; falls back to the server's authoritative segmentIndex
// hint when the local queue is empty/stale. Returns null when no position
// is known — callers must NOT rebuild (rebuilding would restart from 0).
export function planLanguageSwitch(messages, hintSegmentIndex) {
  const msgs = messages || [];
  const pos = msgs.findIndex((m) => m.type === 'lecture' && /_seg_(\d+)$/.test(m.id || ''));
  const localIdx = pos >= 0 ? Number(msgs[pos].id.match(/_seg_(\d+)$/)[1]) : -1;
  const hint = Number.isInteger(hintSegmentIndex) && hintSegmentIndex >= 0 ? hintSegmentIndex : -1;
  const curIdx = localIdx >= 0 ? localIdx : hint;
  if (curIdx < 0) return null;
  return { segmentIndex: curIdx, headIsLecture: pos === 0 };
}

export { lectureSegmentIndex };
