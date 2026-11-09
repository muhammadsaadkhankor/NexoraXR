// Opt-in evaluation logger — enabled ONLY when EVAL_LOG=1. Writes one JSON
// line per record to logs/eval/<runId>.jsonl for offline analysis. Every
// write is wrapped in try/catch: logging must never break or alter the
// lecture hot path. When disabled all exports are cheap no-ops and no file
// or directory is created.
//
// Record shape:
//   { ts_server_ns, runId, roomId, eventId, event, clientId, stateVersion,
//     floorOwner, professorState, segmentId, slideId, payloadSummary }
//
// Event families:
//   in.<socket-event>   — an accepted inbound client event (post-gate)
//   ncip.<method>       — a committed NcipRoom transition (observable state
//                         signature changed during the call)
//   emit.<wire-event>   — an outbound effect emitted by applyEffects
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const ENABLED = process.env.EVAL_LOG === '1';
export const EVAL_RUN_ID =
  process.env.EVAL_RUN_ID || `eval-${Date.now()}-${randomUUID().slice(0, 8)}`;

const LOG_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../logs/eval'
);
const LOG_FILE = path.join(LOG_DIR, `${EVAL_RUN_ID}.jsonl`);

let eventSeq = 0;
let ready = false;

if (ENABLED) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    // Fresh file per run — a reused runId restarts the capture, never appends
    // to a stale one.
    fs.writeFileSync(LOG_FILE, '');
    ready = true;
    console.log(`[eval] EVAL_LOG=1 — writing ${LOG_FILE}`);
  } catch (err) {
    console.error(`[eval] logger init failed, disabled: ${err.message}`);
  }
}

export const evalEnabled = () => ready;
export const evalLogFile = () => LOG_FILE;

// Compact, bounded view of an arbitrary payload: scalars kept (long strings
// truncated), objects collapsed to a marker — a question or answer body must
// never flood the log.
function summarize(value, depth = 0) {
  if (value == null) return null;
  const t = typeof value;
  if (t === 'string') return value.length > 160 ? `${value.slice(0, 160)}...` : value;
  if (t === 'number' || t === 'boolean') return value;
  if (t === 'bigint') return value.toString();
  if (depth >= 2) return Array.isArray(value) ? `[${value.length}]` : '{...}';
  if (Array.isArray(value)) return value.map((v) => summarize(v, depth + 1));
  if (t === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = summarize(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

export function evalRecord(roomId, event, { clientId = null, ncip = null, payload = null } = {}) {
  if (!ready) return;
  try {
    const cp = ncip?.interruption?.checkpoint ?? null;
    const rec = {
      ts_server_ns: process.hrtime.bigint().toString(),
      ts_wall_ms: Date.now(),
      runId: EVAL_RUN_ID,
      roomId: roomId ?? null,
      eventId: eventSeq++,
      event,
      clientId,
      stateVersion: ncip?.stateVersion ?? null,
      floorOwner: ncip?.floor?.holder ?? null,
      professorState: ncip?.professor?.status ?? null,
      segmentId:
        ncip?.lectureProgress?.currentSegmentId ??
        cp?.segmentIndex ??
        ncip?.playback?.segmentIndex ??
        null,
      slideId:
        cp?.slideDoc ??
        (cp?.slidePage != null ? `page:${cp.slidePage}` : null),
      payloadSummary: summarize(payload),
    };
    fs.appendFileSync(LOG_FILE, `${JSON.stringify(rec)}\n`);
  } catch {
    // Eval logging must never break the room.
  }
}

// ---- room instrumentation ------------------------------------------------
//
// A committed transition = an NcipRoom call after which the observable
// protocol signature differs. The signature tracks every field that the wire
// payloads or invariants care about, so mutations that intentionally skip a
// version bump (e.g. playback position, lectureProgress) are still logged —
// versionFrom/versionTo in the payload show whether the bump happened.
const signature = (r) =>
  [
    r.stateVersion,
    r.professor?.status,
    r.floor?.holder,
    (r.floor?.queue || []).join(','),
    r.lectureActive,
    r.lectureProgress?.currentSegmentId,
    r.interruption?.checkpoint ? 1 : 0,
    r.interruption?.pauseReason,
    r.session?.participants?.size,
    r.playback?.segmentIndex,
  ].join('|');

// Methods that may commit protocol state. Pure reads (snapshot, metricsSummary,
// canCatchUp...) and internal helpers (underscore-prefixed, invoked on the raw
// target so they can't double-log inside an outer call) are excluded.
const TRACKED_METHODS = new Set([
  'joinParticipant', 'participantDisconnected', 'expireGrace', 'leave',
  'markRecapSatisfied', 'updatePlayback', 'startLecture', 'endLecture',
  'lectureUnitStarted', 'lectureAdvanced', 'applyLectureAction',
  'recordInteraction', 'recordLateJoiner', 'completeGroupRecap',
  'hostPause', 'hostResume', 'requestFloor', 'cancelRequest', 'releaseFloor',
  'floorTimeoutExpired', 'thinkingTimeoutExpired', 'submitCheckpoint',
  'changeLanguage', 'submitQuestion', 'answerReady', 'answerFailed',
  'answerTimeExpired', 'answerEnded', 'disconnect',
]);

// First-arg participant id for methods whose arg0 is a pid — used as clientId.
// answerReady/answerTimeExpired take answer ids; startLecture takes a
// lectureId; thinkingTimeoutExpired takes a generation token (all logged in
// payloadSummary.args instead).
const PID_ARG0 = new Set([
  'joinParticipant', 'participantDisconnected', 'expireGrace', 'leave',
  'markRecapSatisfied', 'updatePlayback', 'hostPause', 'hostResume',
  'requestFloor', 'cancelRequest', 'releaseFloor', 'floorTimeoutExpired',
  'submitCheckpoint', 'changeLanguage', 'submitQuestion', 'answerFailed',
  'disconnect', 'recordLateJoiner',
]);

export function instrumentEvalRoom(room, roomId) {
  if (!ready) return room;
  return new Proxy(room, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function' || !TRACKED_METHODS.has(prop)) return value;
      return function (...args) {
        const before = signature(target);
        const versionFrom = target.stateVersion;
        const out = Reflect.apply(value, target, args);
        if (signature(target) !== before) {
          evalRecord(roomId, `ncip.${prop}`, {
            clientId: PID_ARG0.has(prop) ? args[0] ?? null : null,
            ncip: target,
            payload: {
              args: args.map((a) => summarize(a)),
              versionFrom,
              versionTo: target.stateVersion,
              ok: out && typeof out === 'object' ? out.ok ?? null : null,
              effects: Array.isArray(out) ? out.length : out?.effects?.length ?? null,
            },
          });
        }
        return out;
      };
    },
  });
}

// ---- call-site helpers (server.js) ----------------------------------------

// Log an accepted inbound socket event. Called after the participant/room
// gate so clientId is the authoritative server-resolved participantId.
export function evalInbound(roomId, clientId, event, payload, ncip) {
  evalRecord(roomId, `in.${event}`, { clientId, ncip, payload });
}

// Log one outbound protocol effect — the observable record of what clients
// were told (floor-state, floor-ready, lecture-control, professor-speak,
// floor-question-error, ...).
export function evalEffect(roomId, effect, ncip) {
  if (!ready || !effect?.event) return;
  evalRecord(roomId, `emit.${effect.event}`, {
    clientId: effect.to && effect.to !== 'room' ? effect.to : null,
    ncip,
    payload: effect.event === 'floor-state' ? null : effect.data,
  });
}
