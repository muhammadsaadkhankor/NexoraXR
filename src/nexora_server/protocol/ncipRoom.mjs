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
  }

  // ---- helpers -----------------------------------------------------------

  _resumeEffects() {
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
    if (this.floor.queue.length > 0) {
      this.floor.holder = this.floor.queue.shift();
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

  // ---- floor control -----------------------------------------------------

  requestFloor(userId) {
    if (this.floor.holder === userId || this.floor.queue.includes(userId)) {
      return []; // already holding or queued — never duplicated
    }
    if (!this.floor.holder) {
      this.floor.holder = userId;
      this.interruption.checkpoint = null;
      this.professor.status = ProfessorStatus.PAUSED;
      return [FLOOR_STATE, pauseCtl(userId)];
    }
    this.floor.queue.push(userId);
    return [FLOOR_STATE];
  }

  cancelRequest(userId) {
    const idx = this.floor.queue.indexOf(userId);
    if (idx === -1) return [];
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
    this.floor.holder = null;
    return [FLOOR_STATE];
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
    if (this.interruption.checkpoint.segmentIndex != null) {
      this.lectureActive = true;
    }
    // Acknowledge readiness so the holder may now submit its question.
    return [ev('floor-ready', { userId }, userId), FLOOR_STATE];
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
    };
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
      this.floor.holder = null;
      effects.push(FLOOR_STATE);
    }
    return effects;
  }
}
