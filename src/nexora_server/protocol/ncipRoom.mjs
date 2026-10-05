// Nexora Classroom Interaction Protocol (NCIP) — per-room server-authoritative
// state machine. Pure transitions only: every method mutates state and returns
// a list of effects for the caller (server.js) to emit over Socket.IO.
//
// Effect shape: { to: 'room' | <socketId>, event: <string>, data?: <object> }
// The reserved event 'floor-state' means "broadcast the built floor-state
// payload" — the server enriches ids with display names before emitting.

export const ProfessorStatus = Object.freeze({
  IDLE: 'IDLE',
  LECTURING: 'LECTURING',
  PAUSED: 'PAUSED',
  THINKING: 'THINKING',
  ANSWERING: 'ANSWERING',
  RESUMING: 'RESUMING',
});

// Room-wide languages — must stay in sync with LECTURE_LANGUAGES in
// nexora_ai/routes/lectureRoutes.mjs and the client LANGUAGES list.
export const SUPPORTED_LANGUAGES = Object.freeze(['en', 'ar', 'fr', 'de', 'es']);

const ev = (event, data, to = 'room') => ({ to, event, data });
const FLOOR_STATE = { to: 'room', event: 'floor-state' };
const pauseCtl = (userId) =>
  ev('lecture-control', { action: 'pause-for-floor', activeSpeaker: { userId } });

export class NcipRoom {
  constructor(roomId) {
    this.roomId = roomId;
    this.floor = { holder: null, queue: [] };
    this.professor = { status: ProfessorStatus.IDLE };
    // Single canonical checkpoint — written once per floor grant, only by the
    // current floor holder. First write wins until the floor advances.
    this.interruption = { checkpoint: null };
    // { id, startedAt, durationMs } — server timing is authoritative for when
    // the answer ends; client 'answer-ended' events are fallback telemetry.
    this.currentAnswer = null;
    this.lectureActive = false;
    // Live playback position reported by clients (segment-start broadcasts).
    // Feeds the snapshot when no floor interruption checkpoint exists so
    // late joiners can recover an in-progress lecture.
    this.playback = null; // {lectureId, segmentIndex, playbackOffsetMs, language, reportedAt}
    // NCIP Slice 3: one authoritative room-wide lecture language.
    this.language = { roomLanguage: 'en' };
    // NCIP Slice 5: server-authoritative floor timeout. The deadline is
    // armed only once the holder's checkpoint is accepted (floor-ready);
    // entering THINKING disarms it. Identity is checked on expiry so a stale
    // timeout can never revoke a newer holder.
    this.FLOOR_TIMEOUT_MS = 30_000;
    this.floorDeadline = null; // { holder, expiresAt }
    // Server-authoritative THINKING timeout: a hung LLM/TTS pipeline must
    // never stall the room. Each question gets a generation token so a late
    // result can be verified against the ACTIVE generation and safely dropped.
    this.THINKING_TIMEOUT_MS = 60_000;
    this.thinkingDeadline = null; // { holder, token, expiresAt }
    this._thinkingSeq = 0;
    // Lightweight protocol metric marks — data only, no scheduling.
    this._marks = {}; // event name -> epoch ms
    // NCIP Slice 4: authoritative participants keyed by a STABLE
    // participantId supplied by the client (persisted client-side), never by
    // the transient socket.id. A disconnect marks the participant offline and
    // starts a reconnect grace window; floor position is preserved until the
    // window expires.
    this.session = { participants: new Map() }; // pid -> {connected, socketId, joinedAt, disconnectedAt}
    this.RECONNECT_GRACE_MS = 10_000;
    this._graceDeadlines = new Map(); // pid -> epoch ms when grace expires
    // NCIP Slice 2: monotonically increasing authoritative state version.
    // Bumped only when protocol state changes (floor / professor / lecture
    // checkpoint / answer lifecycle) — never for avatar movement or chat.
    this.stateVersion = 0;
  }

  _bump() {
    this.stateVersion++;
  }

  // Plain-object projection of participants for wire payloads (snapshot /
  // floor-state). socketId is internal routing state — not exposed.
  sessionParticipants() {
    const out = {};
    for (const [pid, p] of this.session.participants) {
      out[pid] = {
        connected: p.connected,
        joinedAt: p.joinedAt,
        disconnectedAt: p.disconnectedAt,
      };
    }
    return out;
  }

  // ---- participant lifecycle (NCIP Slice 4) -------------------------------

  // Register a participant or rebind it to a (new) socket. Returns flags so
  // the caller can distinguish a first join, a same-socket re-join, and a
  // reconnect during the grace window.
  joinParticipant(pid, socketId, now = Date.now()) {
    const p = this.session.participants.get(pid);
    if (p) {
      const wasOffline = !p.connected;
      const socketChanged = p.socketId !== socketId;
      if (!wasOffline && !socketChanged) {
        return { isNew: false, reconnected: false }; // duplicate join — no state change
      }
      p.connected = true;
      p.socketId = socketId;
      p.disconnectedAt = null;
      this._graceDeadlines.delete(pid);
      this._bump();
      return { isNew: false, reconnected: wasOffline };
    }
    this.session.participants.set(pid, {
      connected: true,
      socketId,
      joinedAt: now,
      disconnectedAt: null,
    });
    this._bump();
    return { isNew: true, reconnected: false };
  }

  // Socket dropped: mark offline and open the grace window. Floor/queue
  // position is preserved until expireGrace runs.
  participantDisconnected(pid, now = Date.now()) {
    const p = this.session.participants.get(pid);
    if (!p || !p.connected) return false;
    p.connected = false;
    p.disconnectedAt = now;
    this._graceDeadlines.set(pid, now + this.RECONNECT_GRACE_MS);
    this._bump();
    return true;
  }

  // Grace expired (or explicit leave): if the participant reconnected the
  // call is a safe no-op — a stale timer can never hurt a live participant.
  // Otherwise remove them and run the standard floor/queue cleanup.
  expireGrace(pid) {
    const p = this.session.participants.get(pid);
    if (!p || p.connected) return [];
    this._graceDeadlines.delete(pid);
    this.session.participants.delete(pid);
    return this.disconnect(pid);
  }

  // Explicit intentional leave = immediate expiry, no grace window.
  leave(pid) {
    this._graceDeadlines.delete(pid);
    if (!this.session.participants.has(pid)) return [];
    this.session.participants.delete(pid);
    return this.disconnect(pid);
  }

  participantCount() {
    return this.session.participants.size;
  }

  // ---- invariants + metrics (NCIP Slice 5) ---------------------------------

  // Internal-consistency assertions over the authoritative state. Throws on
  // violation; meant to be called by tests after each transition (S1–S10
  // that are checkable inside the state machine).
  assertConsistent() {
    const bad = (msg) => { throw new Error(`NCIP invariant violated: ${msg}`); };
    // S1: at most one holder; holder never appears in queue; queue unique.
    if (this.floor.holder && this.floor.queue.includes(this.floor.holder)) bad('holder duplicated in queue (S1)');
    if (new Set(this.floor.queue).size !== this.floor.queue.length) bad('duplicate queued participant (S1)');
    // S4: THINKING/ANSWERING requires the canonical checkpoint to exist.
    if ((this.professor.status === ProfessorStatus.THINKING ||
         this.professor.status === ProfessorStatus.ANSWERING) &&
        !this.interruption.checkpoint) bad('question state without checkpoint (S4)');
    // answer object exists iff ANSWERING.
    if (this.professor.status === ProfessorStatus.ANSWERING && !this.currentAnswer) bad('ANSWERING without currentAnswer');
    if (this.professor.status !== ProfessorStatus.ANSWERING && this.currentAnswer) bad('currentAnswer outside ANSWERING');
    // Floor deadline only while PAUSED and bound to the current holder.
    if (this.floorDeadline) {
      if (this.professor.status !== ProfessorStatus.PAUSED) bad('armed floor timeout outside PAUSED');
      if (this.floorDeadline.holder !== this.floor.holder) bad('floor timeout bound to wrong holder');
    }
    // Thinking deadline only while THINKING.
    if (this.thinkingDeadline && this.professor.status !== ProfessorStatus.THINKING) {
      bad('armed thinking timeout outside THINKING');
    }
    // Floor references only known participants (when session tracking is used).
    if (this.session.participants.size > 0) {
      for (const pid of [this.floor.holder, ...this.floor.queue]) {
        if (pid && !this.session.participants.has(pid)) bad(`floor references unknown participant ${pid}`);
      }
    }
    return true;
  }

  _mark(name, now = Date.now()) {
    this._marks[name] = now;
  }

  // Computed latencies from recorded marks; null where a pair is incomplete.
  metricsSummary() {
    const m = this._marks;
    const d = (a, b) => (Number.isFinite(a) && Number.isFinite(b) ? b - a : null);
    return {
      requestToGrantMs: m['req'] != null ? d(m['req'], m['grant']) : null,
      submitToAnswerStartMs: d(m['submit'], m['answerStart']),
      answerEndToResumeMs: d(m['answerEnd'], m['resume']),
      marks: { ...m },
    };
  }

  // Authoritative recovery snapshot — everything a (re)connecting or gapped
  // client needs to converge without replaying missed events.
  snapshot() {
    const cp = this.interruption.checkpoint;
    // A floor interruption checkpoint is always the canonical position; the
    // live playback report is the fallback for uninterrupted lecturing —
    // its offset is projected forward by the time elapsed since the segment
    // started (only while actively LECTURING; paused states keep the cp).
    const pp = this.playback;
    return {
      stateVersion: this.stateVersion,
      floor: { holder: this.floor.holder, queue: [...this.floor.queue] },
      professor: { status: this.professor.status },
      lecture: {
        active: this.lectureActive,
        lectureId: cp?.lectureId ?? pp?.lectureId ?? null,
        segmentIndex: cp?.segmentIndex ?? pp?.segmentIndex ?? null,
        playbackOffsetMs: cp?.playbackOffsetMs ??
          (pp ? pp.playbackOffsetMs +
            (this.professor.status === ProfessorStatus.LECTURING
              ? Math.max(0, Date.now() - pp.reportedAt) : 0)
            : 0),
        language: cp?.language ?? pp?.language ?? this.language.roomLanguage,
      },
      interruption: { checkpoint: cp },
      language: { roomLanguage: this.language.roomLanguage },
      session: { participants: this.sessionParticipants() },
      currentAnswer: this.currentAnswer ? { ...this.currentAnswer } : null,
      // Server clock stamp — the client computes answer elapsed time against
      // the same clock that wrote startedAt; no client/server skew involved.
      serverNow: Date.now(),
    };
  }

  // ---- helpers -----------------------------------------------------------

  _resumeEffects() {
    this._mark('resume');
    return [
      ev('lecture-control', {
        action: 'resume',
        checkpoint: this.interruption.checkpoint,
      }),
    ];
  }

  // Floor release / answer end / failure all converge here: next queued
  // student gets the floor (lecture stays paused, checkpoint reset for the
  // new holder) or the lecture resumes from the saved checkpoint.
  _advanceFloor() {
    this._bump();
    this.floorDeadline = null; // a new holder arms their own timeout at floor-ready
    if (this.floor.queue.length > 0) {
      this.floor.holder = this.floor.queue.shift();
      this._mark('grant');
      this.interruption.checkpoint = null;
      this.professor.status = ProfessorStatus.PAUSED;
      return [FLOOR_STATE, pauseCtl(this.floor.holder)];
    }
    this.floor.holder = null;
    this.professor.status = ProfessorStatus.RESUMING;
    const effects = [FLOOR_STATE, ...this._resumeEffects()];
    this.interruption.checkpoint = null;
    this.professor.status = this.lectureActive
      ? ProfessorStatus.LECTURING
      : ProfessorStatus.IDLE;
    return effects;
  }

  // ---- lecture playback tracking (late-join recovery) ---------------------
  //
  // Clients broadcast each lecture-segment head via professor-speak; the
  // server records it as the authoritative live position. The first report
  // also flips IDLE -> LECTURING so the professor state is authoritative
  // even before any floor interruption has occurred.
  updatePlayback(pid, pos, now = Date.now()) {
    if (!pos || typeof pos.lectureId !== 'string' || !Number.isInteger(pos.segmentIndex)) return [];
    this.playback = {
      lectureId: pos.lectureId,
      segmentIndex: pos.segmentIndex,
      playbackOffsetMs: Math.max(0, pos.playbackOffsetMs || 0),
      language: pos.language || this.language.roomLanguage,
      reportedAt: now,
    };
    this.lectureActive = true;
    if (this.professor.status === ProfessorStatus.IDLE) {
      this._bump();
      this.professor.status = ProfessorStatus.LECTURING;
      return [FLOOR_STATE];
    }
    return [];
  }

  // The lecture queue drained — live position is no longer valid.
  endLecture(pid) {
    this.playback = null;
    const wasActive = this.lectureActive;
    this.lectureActive = false;
    if (this.professor.status === ProfessorStatus.LECTURING) {
      this.professor.status = ProfessorStatus.IDLE;
      this._bump();
    }
    return wasActive ? [FLOOR_STATE] : [];
  }

  // ---- floor control -----------------------------------------------------

  requestFloor(userId) {
    if (this.floor.holder === userId || this.floor.queue.includes(userId)) {
      return []; // already holding or queued — never duplicated
    }
    this._mark('req');
    if (!this.floor.holder) {
      this._bump();
      this.floor.holder = userId;
      this.interruption.checkpoint = null;
      this.floorDeadline = null;
      this.professor.status = ProfessorStatus.PAUSED;
      this._mark('grant');
      return [FLOOR_STATE, pauseCtl(userId)];
    }
    this._bump();
    this.floor.queue.push(userId);
    return [FLOOR_STATE];
  }

  cancelRequest(userId) {
    const idx = this.floor.queue.indexOf(userId);
    if (idx === -1) return [];
    this._bump();
    this.floor.queue.splice(idx, 1);
    return [FLOOR_STATE];
  }

  releaseFloor(userId) {
    if (this.floor.holder !== userId) return [];
    if (this.professor.status === ProfessorStatus.PAUSED) {
      return this._advanceFloor();
    }
    // A question is in flight (THINKING/ANSWERING): the holder gives up the
    // floor but the answer still completes for the room.
    this._bump();
    this.floorDeadline = null;
    this.floor.holder = null;
    return [FLOOR_STATE];
  }

  // NCIP Slice 5: authoritative floor timeout. Fires only while the SAME
  // holder is still PAUSED (i.e. checkpointed but never submitted) and the
  // deadline has actually passed — a stale firing is a no-op, so it can
  // never revoke a newer holder or a holder whose question entered THINKING.
  floorTimeoutExpired(pid, now = Date.now()) {
    const d = this.floorDeadline;
    if (!d || d.holder !== pid) return [];
    if (this.floor.holder !== pid) return [];
    if (this.professor.status !== ProfessorStatus.PAUSED) return [];
    if (now < d.expiresAt) return [];
    this.floorDeadline = null;
    this.floor.holder = null;
    return this._advanceFloor();
  }

  // NCIP Slice 5 THINKING timeout — fires only if the SAME generation is
  // still THINKING and its deadline passed; every other case is a safe no-op.
  thinkingTimeoutExpired(token, now = Date.now()) {
    const d = this.thinkingDeadline;
    if (!d || d.token !== token) return [];
    if (this.professor.status !== ProfessorStatus.THINKING) return [];
    if (now < d.expiresAt) return [];
    // Reuse the existing answer-failure recovery: release holder, then grant
    // the next queued student or resume from the canonical checkpoint.
    return this.answerFailed(d.holder, 'The professor took too long to answer. Please ask again.');
  }

  // A late LLM/TTS result is only valid while its own generation is still
  // the active THINKING cycle.
  isActiveGeneration(token) {
    return this.professor.status === ProfessorStatus.THINKING &&
      this.thinkingDeadline?.token === token;
  }

  // ---- lecture interruption checkpoint -----------------------------------

  // Only the current floor holder may write the canonical checkpoint, and
  // only once per grant — later reports (from the holder or anyone else)
  // are ignored. A report with segmentIndex=null means "the holder has no
  // lecture playing locally"; it still counts as a valid checkpoint record
  // so the floor can proceed deterministically.
  submitCheckpoint(userId, checkpoint) {
    if (this.floor.holder !== userId) return [];
    if (this.interruption.checkpoint) return [];
    if (!checkpoint || typeof checkpoint !== 'object') return [];
    this.interruption.checkpoint = {
      lectureId: checkpoint.lectureId ?? null,
      segmentIndex: Number.isFinite(checkpoint.segmentIndex) ? checkpoint.segmentIndex : null,
      playbackOffsetMs: Number.isFinite(checkpoint.playbackOffsetMs) ? checkpoint.playbackOffsetMs : 0,
      language: checkpoint.language || 'en',
      reportedBy: userId,
      reportedAt: Date.now(),
    };
    this._bump();
    // Floor fully ready: arm the authoritative floor timeout — the holder
    // has FLOOR_TIMEOUT_MS to submit a valid question.
    this.floorDeadline = { holder: userId, expiresAt: Date.now() + this.FLOOR_TIMEOUT_MS };
    if (this.interruption.checkpoint.segmentIndex != null) {
      this.lectureActive = true;
    }
    // Acknowledge readiness so the holder may now submit its question.
    return [ev('floor-ready', { userId }, userId), FLOOR_STATE];
  }

  // ---- room language (NCIP Slice 3) --------------------------------------
  //
  // One room-wide language; every client converges to it. The change is an
  // authoritative mutation: version bumps and a 'language-change'
  // lecture-control broadcast tells each client to rebuild its queue from its
  // current logical position (same lectureId + segmentIndex — cross-language
  // millisecond alignment is not supported, segments restart from their
  // beginning, which matches the existing mid-lecture switch behavior).
  //
  // Per-status rules:
  //   LECTURING/RESUMING — clients rebuild from their current segment in the
  //                        new language; nothing else changes.
  //   PAUSED/THINKING/ANSWERING — the canonical interruption checkpoint is
  //                        retargeted to the new language so the future
  //                        'resume' carries it; floor/answer flow untouched.
  //   ANSWERING — the in-flight answer still finishes in its original
  //                        language; only the subsequent resume switches.
  changeLanguage(userId, language) {
    if (!SUPPORTED_LANGUAGES.includes(language)) {
      return { ok: false, error: `Unsupported language '${language}'.` };
    }
    if (language === this.language.roomLanguage) {
      return { ok: true, effects: [] }; // no-op — must not bump the version
    }
    this._bump();
    this.language.roomLanguage = language;
    if (this.interruption.checkpoint) {
      this.interruption.checkpoint.language = language;
    }
    return {
      ok: true,
      effects: [
        // segmentIndex hint: canonical checkpoint first, else the live
        // playback position — lets clients rebuild even if their local
        // queue is momentarily empty (prevents accidental seg-0 restarts).
        ev('lecture-control', {
          action: 'language-change',
          language,
          segmentIndex: this.interruption.checkpoint?.segmentIndex ??
            this.playback?.segmentIndex ?? null,
        }),
        FLOOR_STATE,
      ],
    };
  }

  // ---- question / answer lifecycle ---------------------------------------

  // A question may only enter THINKING once the holder's checkpoint exists.
  submitQuestion(userId, question) {
    if (this.floor.holder !== userId) {
      return { ok: false, error: 'Only the floor holder can ask a question.' };
    }
    if (this.professor.status !== ProfessorStatus.PAUSED) {
      return { ok: false, error: 'The professor is not ready for a question.' };
    }
    if (!this.interruption.checkpoint) {
      return { ok: false, error: 'Lecture checkpoint not captured yet.' };
    }
    this.professor.status = ProfessorStatus.THINKING;
    this._bump();
    this.floorDeadline = null; // valid question submitted — floor timeout disarmed
    // Arm the generation timeout; the token binds late LLM/TTS results and
    // timeout callbacks to THIS question cycle.
    this._thinkingSeq++;
    this.thinkingDeadline = {
      holder: userId,
      token: `gen${this._thinkingSeq}`,
      expiresAt: Date.now() + this.THINKING_TIMEOUT_MS,
    };
    this._mark('submit');
    return {
      ok: true,
      effects: [
        ev('lecture-control', {
          action: 'thinking',
          askedBy: { userId },
          question,
        }),
      ],
    };
  }

  answerReady(answerId, message, durationMs = null) {
    if (this.professor.status !== ProfessorStatus.THINKING) return [];
    this.professor.status = ProfessorStatus.ANSWERING;
    this.currentAnswer = {
      id: answerId,
      startedAt: Date.now(),
      durationMs: Number.isFinite(durationMs) ? durationMs : null,
      // Replay payload — a late joiner uses it to hear the remainder of the
      // in-flight answer from the elapsed position (NCIP Slice 2 fix).
      text: message?.text ?? null,
      audioUrl: message?.audioUrl ?? null,
      lipsync: message?.lipsync ?? null,
      animation: message?.animation ?? null,
      facialExpression: message?.facialExpression ?? null,
    };
    this._bump();
    this.thinkingDeadline = null; // answer started — generation timeout disarmed
    this._mark('answerStart', this.currentAnswer.startedAt);
    return [
      ev('professor-speak', {
        ...message,
        id: answerId,
        floorAnswer: true,
        durationMs: this.currentAnswer.durationMs,
      }),
    ];
  }

  // Generation failed while THINKING: leave THINKING, release the holder,
  // then grant the next student or resume the lecture.
  answerFailed(askerId, errorText) {
    if (this.professor.status !== ProfessorStatus.THINKING) return [];
    this._bump();
    this.thinkingDeadline = null; // normal failure also disarms the timeout
    const effects = [
      ev('floor-question-error', { error: errorText }, askerId || 'room'),
      ev('lecture-control', { action: 'answer-error' }),
    ];
    this.currentAnswer = null;
    this.floor.holder = null;
    effects.push(...this._advanceFloor());
    return effects;
  }

  _finishAnswer() {
    this.currentAnswer = null;
    this.floor.holder = null;
    this._mark('answerEnd');
    return this._advanceFloor();
  }

  // Authoritative completion: the server-side timer fires when the answer
  // audio should have finished everywhere (duration + slack, scheduled by
  // server.js). Stale/late calls are no-ops.
  answerTimeExpired(answerId) {
    if (this.professor.status !== ProfessorStatus.ANSWERING) return [];
    if (!this.currentAnswer || this.currentAnswer.id !== answerId) return [];
    return this._finishAnswer();
  }

  // Client telemetry/fallback: a report only advances the protocol if the
  // server-measured duration has already elapsed (i.e. the timer somehow
  // missed). A fast client can never end the answer early for the room.
  answerEnded(answerId, now = Date.now()) {
    if (this.professor.status !== ProfessorStatus.ANSWERING) return [];
    if (!this.currentAnswer || this.currentAnswer.id !== answerId) return [];
    const { startedAt, durationMs } = this.currentAnswer;
    if (durationMs == null || now - startedAt >= durationMs) {
      return this._finishAnswer();
    }
    return [];
  }

  // ---- disconnect ----------------------------------------------------------

  disconnect(userId) {
    const effects = [];
    const qIdx = this.floor.queue.indexOf(userId);
    if (qIdx !== -1) {
      this._bump();
      this.floor.queue.splice(qIdx, 1);
      effects.push(FLOOR_STATE);
    }
    if (this.floor.holder !== userId) return effects;

    if (this.professor.status === ProfessorStatus.PAUSED) {
      // Holder left before asking: revoke the floor — next queued student or
      // resume the lecture from the checkpoint.
      this.floor.holder = null;
      effects.push(...this._advanceFloor());
    } else {
      // THINKING/ANSWERING: question already submitted — let the answer
      // finish for the room; the floor holder is simply gone.
      this._bump();
      this.floor.holder = null;
      effects.push(FLOOR_STATE);
    }
    return effects;
  }
}
