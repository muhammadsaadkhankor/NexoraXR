// Simulated NCIP student — a headless socket.io-client that mirrors the real
// client's floor protocol: request-floor -> (granted) lecture-checkpoint ->
// (floor-ready) ask-floor-question -> (floorAnswer) answer-ended ->
// release-floor. Records client-side timestamps for the rep report.
import { createRequire } from 'node:module';

const require = createRequire(
  new URL('../../src/nexora_client/package.json', import.meta.url)
);
const { io: ioClient } = require('socket.io-client');

const now = () => performance.now();

export class Student {
  constructor({ base, roomId, pid, lectureId }) {
    this.base = base;
    this.roomId = roomId;
    this.pid = pid;
    this.lectureId = lectureId;
    this.professorStatus = null;
    this.lastSegIndex = 0;
    this.stateVersion = null;
    // Every observed (stateVersion -> holder) pair — the oracle compares these
    // beliefs against the server's authoritative owner at the same version.
    this.floorObs = [];
    this.lastFloorState = null;
    this.isReconnect = false;
    // Per-rep timing record (ms, performance.now relative to rep start).
    this.rec = {
      pid, tRequest: null, tGrant: null, tReady: null,
      tAnswerStart: null, tAnswerEnd: null, tRelease: null,
      outcome: 'joined', requestsSent: 0, floorErrors: [],
      tDisconnect: null, tDisconnectWall: null,
      reconnectOf: null, reconnectOutcome: null,
    };
    this._answerTimer = null;
  }

  connect() {
    return new Promise((res, rej) => {
      this.s = ioClient(this.base, { transports: ['websocket'], reconnection: false });
      this.s.on('connect', () => res(this));
      this.s.on('connect_error', rej);
      this._wire();
    });
  }

  _wire() {
    this.s.on('floor-state', (d) => {
      this.professorStatus = d?.professorStatus ?? this.professorStatus;
      this.stateVersion = d?.stateVersion ?? this.stateVersion;
      const holder = d?.activeSpeaker?.userId ?? null;
      this.lastFloorState = d;
      this.floorObs.push({ v: this.stateVersion, holder, t: now() });
      if (this.floorObs.length > 400) this.floorObs.splice(0, this.floorObs.length - 400);
      // Reconnect check (first floor-state after re-join decides it): did the
      // participant keep the floor, land back in the queue, or lose it?
      if (this.isReconnect && this.rec.reconnectOutcome == null) {
        const queued = (d?.floorQueue || []).some((q) => q.userId === this.pid);
        this.rec.reconnectOutcome =
          holder === this.pid ? 'kept' : queued ? 'requeued' : 'lost';
      }
      if (holder === this.pid && this.rec.tGrant == null) {
        this.rec.tGrant = now();
        this.onGrant?.(this);
      }
      if (holder == null && this.rec.tGrant != null && this.rec.tRelease == null
          && this.rec.outcome === 'joined') {
        // Floor left us without our own release (timeout/kick/server advance).
        this.rec.outcome = 'floor-lost';
      }
    });
    this.s.on('floor-ready', (d) => {
      if (d?.userId !== this.pid) return;
      this.rec.tReady = now();
      this.onReady?.(this);
    });
    this.s.on('floor-question-error', (d) => {
      this.rec.floorErrors.push(d?.error || 'unknown');
    });
    this.s.on('professor-speak', (d) => {
      const m = /^(.+)_seg_(\d+)$/.exec(d?.id || '');
      if (m) this.lastSegIndex = Number(m[2]);
      if (d?.floorAnswer && d?.askedBy === this.pid) {
        this.rec.tAnswerStart = now();
        const wait = (Number.isFinite(d?.durationMs) ? d.durationMs : 250) + 60;
        this._answerTimer = setTimeout(() => {
          this.s.emit('answer-ended', { id: d.id, audioMs: d.durationMs ?? null });
          this.rec.tAnswerEnd = now();
          this.onAnswerDone?.(this);
        }, wait);
      }
    });
  }

  join() {
    this.s.emit('join', {
      roomId: this.roomId,
      name: this.pid,
      participantId: this.pid,
    });
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`${this.pid}: join timeout`)), 8000);
      this.s.on('self-info', (d) => {
        if (d?.participantId === this.pid) { clearTimeout(t); res(d); }
      });
      this.s.on('join-error', (e) => { clearTimeout(t); rej(new Error(`join rejected: ${e?.error}`)); });
    });
  }

  requestFloor() {
    this.s.emit('request-floor');
    this.rec.requestsSent++;
    if (this.rec.tRequest == null) this.rec.tRequest = now();
  }

  submitCheckpoint() {
    this.s.emit('lecture-checkpoint', {
      lectureId: this.lectureId,
      segmentIndex: this.lastSegIndex,
      playbackOffsetMs: 0,
      language: 'en',
    });
  }

  askQuestion() {
    this.s.emit('ask-floor-question', {
      question: `Benchmark question from ${this.pid}`,
      lectureId: this.lectureId,
    });
  }

  releaseFloor() {
    this.s.emit('release-floor');
    this.rec.tRelease = now();
    if (this.rec.outcome === 'joined') this.rec.outcome = 'released';
  }

  leave() {
    try { this.s.emit('leave'); } catch {}
  }

  disconnect() {
    if (this._answerTimer) clearTimeout(this._answerTimer);
    if (this.rec.tDisconnect == null) {
      this.rec.tDisconnect = now();      // client monotonic
      this.rec.tDisconnectWall = Date.now(); // wall clock (same host as server)
    }
    try { this.s.disconnect(); } catch {}
    if (this.rec.outcome === 'joined') this.rec.outcome = 'disconnected';
  }
}
