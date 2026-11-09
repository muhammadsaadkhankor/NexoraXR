// Protocol oracle — replays a server eval log (logs/eval/<runId>.jsonl) plus
// the matching client-side rep records and counts correctness violations.
//
// Checks, per room (= one rep):
//   (a) transitions       — consecutive distinct professorState values that
//                           are not in ALLOWED_TRANSITIONS
//   (b) ownerMismatches   — a client's believed holder at stateVersion v
//                           differs from the server's floorOwner at v
//   (c) fifoViolations    — grants delivered out of request arrival order
//                           (in.request-floor event order is authoritative)
//   (d) illegalOwnerChanges — every floorOwner change must trace to a legal
//                           event (free-floor grant, release, answer-end
//                           handoff, grace expiry, removal, timeout/failure,
//                           lecture reset, or reconnect restore); a steal
//                           hidden behind a normal version bump lands here.
//
// Also extracts disconnect timing for D-* scenarios:
//   detectWall  — server ts_wall_ms of in.disconnect for the dropped pid
//   reassignWall/removedWall — when the floor actually left that pid
//   rejoinWall  — in.join reconnected=true for that pid, if any
//
//   node eval/floor/oracle.mjs <serverLog.jsonl> [repResults.jsonl ...]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Distinct consecutive professorState pairs observed in ncipRoom.mjs.
// RESUMING is transient (resolved inside _advanceFloor/hostResume before
// effects emit) but allowed defensively. * -> IDLE covers endLecture.
export const ALLOWED_TRANSITIONS = new Set([
  'IDLE>LECTURING', 'IDLE>PAUSED', 'IDLE>IDLE',
  'LECTURING>PAUSED', 'LECTURING>IDLE', 'LECTURING>RESUMING',
  'PAUSED>THINKING', 'PAUSED>LECTURING', 'PAUSED>IDLE', 'PAUSED>RESUMING',
  'THINKING>ANSWERING', 'THINKING>PAUSED', 'THINKING>LECTURING',
  'THINKING>IDLE', 'THINKING>RESUMING',
  'ANSWERING>PAUSED', 'ANSWERING>LECTURING', 'ANSWERING>IDLE',
  'ANSWERING>RESUMING',
  'RESUMING>LECTURING', 'RESUMING>IDLE', 'RESUMING>PAUSED',
]);

export function readEvalLog(file) {
  const rooms = new Map(); // roomId -> records in eventId order
  if (!fs.existsSync(file)) return rooms;
  for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    if (r.roomId == null) continue;
    if (!rooms.has(r.roomId)) rooms.set(r.roomId, []);
    rooms.get(r.roomId).push(r);
  }
  return rooms;
}

// (a) Illegal professor-state transitions.
function checkTransitions(recs) {
  const violations = [];
  let prev = null;
  for (const r of recs) {
    const cur = r.professorState;
    if (typeof cur !== 'string') continue;
    if (prev != null && cur !== prev && !ALLOWED_TRANSITIONS.has(`${prev}>${cur}`)) {
      violations.push({ from: prev, to: cur, eventId: r.eventId, event: r.event });
    }
    prev = cur;
  }
  return violations;
}

// (c) FIFO: request arrival order (first in.request-floor per pid) vs the
// order holders appear in floorOwner. A queued pid is only droppable once
// actually removed (leave/expireGrace/disconnect) — a bare disconnect keeps
// its queue slot during the grace window.
function checkFifo(recs) {
  const reqOrder = [];
  const seen = new Set();
  const removedAt = new Map();
  const grants = [];
  let prevOwner = null;
  for (const r of recs) {
    if (r.event === 'in.request-floor' && r.clientId && !seen.has(r.clientId)) {
      seen.add(r.clientId);
      reqOrder.push(r.clientId);
    }
    if (r.clientId && (r.event === 'ncip.leave' || r.event === 'ncip.expireGrace'
        || r.event === 'ncip.disconnect')) {
      if (!removedAt.has(r.clientId)) removedAt.set(r.clientId, r.eventId);
    }
    const owner = r.floorOwner ?? null;
    if (owner !== prevOwner && owner != null) {
      grants.push({ pid: owner, eventId: r.eventId });
    }
    prevOwner = owner;
  }
  const pending = [...reqOrder];
  let violations = 0;
  const detail = [];
  for (const g of grants) {
    while (pending.length && removedAt.has(pending[0])
           && removedAt.get(pending[0]) < g.eventId) {
      pending.shift();
    }
    if (!pending.length) break;
    if (g.pid === pending[0]) { pending.shift(); continue; }
    const idx = pending.indexOf(g.pid);
    if (idx === -1) continue; // holder whose request predates this room's log
    violations++;
    detail.push({ granted: g.pid, expected: pending[0], eventId: g.eventId });
    pending.splice(idx, 1);
  }
  return { violations, detail, requestOrder: reqOrder, grantOrder: grants.map((g) => g.pid) };
}

// (d) Owner-change causality. The first record carrying a different
// floorOwner is the post-state record of the causing transition (ncip.*
// records are logged after the method runs). LEGAL_CAUSES enumerates every
// transition that may move the floor. A requestFloor grant is only legal
// from a free floor — an owner change while the floor is held means a
// steal (M1 hides it inside one version; M1b bumps but still violates).
const LEGAL_OWNER_CAUSES = new Set([
  'ncip.releaseFloor',
  'ncip.answerEnded', 'ncip.answerTimeExpired', // answer-end handoff
  'ncip.answerFailed',                           // generation failure handoff
  'ncip.floorTimeoutExpired', 'ncip.thinkingTimeoutExpired',
  'ncip.disconnect', 'ncip.leave', 'ncip.expireGrace', // removal paths
  'ncip.endLecture', 'ncip.startLecture',              // lecture reset
  'in.join',                                          // reconnect restore
]);
function checkOwnerChanges(recs) {
  const violations = [];
  let prev;
  for (const r of recs) {
    if (r.floorOwner === undefined) continue;
    const owner = r.floorOwner ?? null;
    if (prev !== undefined && owner !== prev) {
      const legal = LEGAL_OWNER_CAUSES.has(r.event)
        || (r.event === 'ncip.requestFloor' && prev === null);
      if (!legal) {
        violations.push({ event: r.event, from: prev, to: owner, eventId: r.eventId });
      }
    }
    prev = owner;
  }
  return violations;
}

// (b) Client belief vs authoritative owner, per stateVersion. Built from
// emit.floor-state records (broadcast only — the join-time targeted emit
// isn't in applyEffects and simply stays unverifiable).
function checkBeliefs(recs, repRec) {
  const ownerAtV = new Map();
  for (const r of recs) {
    if (r.event === 'emit.floor-state' && r.stateVersion != null) {
      ownerAtV.set(r.stateVersion, r.floorOwner ?? null);
    }
  }
  let mismatches = 0;
  let compared = 0;
  const detail = [];
  for (const st of repRec?.students || []) {
    for (const obs of st.floorObs || []) {
      if (obs.v == null || !ownerAtV.has(obs.v)) continue;
      compared++;
      const owner = ownerAtV.get(obs.v);
      if ((owner ?? null) !== (obs.holder ?? null)) {
        mismatches++;
        if (detail.length < 20) {
          detail.push({ pid: st.pid, v: obs.v, client: obs.holder, server: owner });
        }
      }
    }
  }
  return { mismatches, compared, detail };
}

// Disconnect timing per dropped participant.
function disconnectInfo(recs) {
  const out = [];
  const byPid = new Map();
  for (const r of recs) {
    if (r.event === 'in.disconnect' && r.clientId && !byPid.has(r.clientId)) {
      const p = { pid: r.clientId, detectWall: r.ts_wall_ms ?? null, detectEventId: r.eventId };
      byPid.set(r.clientId, p);
      out.push(p);
      continue;
    }
    for (const p of byPid.values()) {
      // Participant actually dropped (grace expired / explicit removal).
      if (p.removedEventId == null && r.clientId === p.pid
          && (r.event === 'ncip.expireGrace' || r.event === 'ncip.leave'
              || r.event === 'ncip.disconnect')) {
        p.removedEventId = r.eventId;
        p.removedWall = r.ts_wall_ms ?? null;
      }
      // Floor reassigned to someone else — only meaningful after removal.
      if (p.removedEventId != null && p.reassignEventId == null
          && r.floorOwner && r.floorOwner !== p.pid && r.eventId >= p.removedEventId) {
        p.reassignEventId = r.eventId;
        p.reassignWall = r.ts_wall_ms ?? null;
        p.nextOwner = r.floorOwner;
      }
      // Reconnected during grace — floor is kept, recovery is moot.
      if (p.rejoinEventId == null && r.event === 'in.join'
          && r.clientId === p.pid && r.payloadSummary?.reconnected === true) {
        p.rejoinEventId = r.eventId;
        p.rejoinWall = r.ts_wall_ms ?? null;
      }
    }
  }
  return out;
}

// repRecords: array of rep result objects (already loaded). Returns per-room
// findings plus totals.
export function oracleReport(serverLogFile, repRecords = []) {
  const rooms = readEvalLog(serverLogFile);
  const repByRoom = new Map(repRecords.map((r) => [r.roomId, r]));
  const perRoom = {};
  const totals = {
    transitionViolations: 0, ownerMismatches: 0, fifoViolations: 0,
    illegalOwnerChanges: 0, compared: 0, rooms: rooms.size,
  };
  for (const [roomId, recs] of rooms) {
    const tv = checkTransitions(recs);
    const fifo = checkFifo(recs);
    const beliefs = checkBeliefs(recs, repByRoom.get(roomId));
    const ownerCh = checkOwnerChanges(recs);
    const disc = disconnectInfo(recs);
    perRoom[roomId] = {
      transitionViolations: tv,
      fifoViolations: fifo.violations,
      fifoDetail: fifo.detail,
      requestOrder: fifo.requestOrder,
      grantOrder: fifo.grantOrder,
      ownerMismatches: beliefs.mismatches,
      compared: beliefs.compared,
      beliefDetail: beliefs.detail,
      illegalOwnerChanges: ownerCh,
      disconnects: disc,
    };
    totals.transitionViolations += tv.length;
    totals.ownerMismatches += beliefs.mismatches;
    totals.fifoViolations += fifo.violations;
    totals.illegalOwnerChanges += ownerCh.length;
    totals.compared += beliefs.compared;
  }
  return { perRoom, totals };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [log, ...repFiles] = process.argv.slice(2);
  if (!log) {
    console.error('usage: node eval/floor/oracle.mjs <serverLog.jsonl> [repResults.jsonl ...]');
    process.exit(1);
  }
  const reps = [];
  for (const f of repFiles) {
    for (const line of fs.readFileSync(f, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        if (r?.type === 'rep') reps.push(r);
      } catch { /* skip */ }
    }
  }
  const { perRoom, totals } = oracleReport(path.resolve(log), reps);
  for (const [room, o] of Object.entries(perRoom)) {
    const bad = o.transitionViolations.length + o.ownerMismatches
      + o.fifoViolations + o.illegalOwnerChanges.length;
    if (!bad) continue;
    console.log(room, JSON.stringify({
      transitionViolations: o.transitionViolations,
      ownerMismatches: o.ownerMismatches,
      fifoViolations: o.fifoViolations,
      fifoDetail: o.fifoDetail,
      beliefDetail: o.beliefDetail,
      illegalOwnerChanges: o.illegalOwnerChanges,
    }));
  }
  console.log('totals:', JSON.stringify(totals));
}
