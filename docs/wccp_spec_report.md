# WCCP (NCIP) — Classroom Coordination Protocol Specification Report

Scope: the classroom coordination protocol implemented in this repository
(called **NCIP** in code — `NcipRoom`, `ncipSync`, `ncipResume`; referred to
as **WCCP** in the paper). This document describes what the code *does*, with
file:line citations. Anything inferred rather than read directly is marked
**INFERRED**; unimplemented behaviour is marked **NOT IMPLEMENTED**.

All paths are relative to the repository root
(`/home/msaad/MuhammadSaad_Workspace/Master-Research/NexoraXR`).

Commit at time of writing: `3395164` (`eval-floor` branch), working tree
clean (`git status --porcelain` empty).

---

## 1. ROLES AND COMPONENTS

| Role | Where | May send | May receive |
|---|---|---|---|
| **Learner** (browser client) | `src/nexora_client/src/classroom/Scene.jsx` | `join`, `request-floor`, `cancel-floor-request`, `release-floor`, `ask-floor-question`, `lecture-checkpoint`, `lecture-checkpoint-mine`, `lecture-segment-ended`, `answer-ended`, `professor-speak` (segment-start report), `language.mine`, `state-update`, `session.sync`, `lecture.start`, `lecture-ended`, `chat`, `webrtc-signal`, `time.ping`, `mic.*` | All room broadcasts (`floor-state`, `lecture-control`, `professor-speak`, `session.snapshot`, `self-info`, …) |
| **Server** (authoritative) | `src/nexora_server/server.js` + `protocol/ncipRoom.mjs` | `floor-state`, `lecture-control` (pause-for-floor / resume / thinking / language-change / …), `professor-speak`, `floor-ready`, `floor-question-error`, `session.snapshot`, `self-info`, `time.pong`, mic/room events | All client events above; agent decisions from `professorAgent.mjs` |
| **Professor agent** (orchestrator, server-side) | `src/nexora_server/server.js` (`emitNextLectureUnit`, ~L1609–1900) + `src/nexora_server/agent/professorAgent.mjs` (`decide`) | lecture units (`professor-speak` per language group), dynamic utterances (opening/transition/reexplain/closing_recap/group_recap) | Room state via `ncipRoom` methods; `lecture_plan.json`; RAG context |
| **Room host / facilitator** | same learner socket + role flags (`isRoomHost`, `isRoomOwner`, INSTRUCTOR/SUPER_ADMIN) | additionally: `language.change` (room-wide), `lecture-control {pause,resume,end}`, `private-join-decision`, `room.kick`, `mic.decision`, `mic.revoke` | same |
| **Simulated learner** (eval only) | `eval/floor/student.mjs`, `eval/resume/holder.mjs` | same protocol events via `socket.io-client` | same |

**Authority split:** the server (`NcipRoom`) is authoritative for floor
ownership, queue order, professor status, the canonical interruption
checkpoint, room language, timeouts, and `stateVersion`
(`ncipRoom.mjs:41–125`). The client is authoritative only for its own
playback position, its local message queue, and (since the resume fix) its
locally recorded pause checkpoint (`Scene.jsx:935, 1676–1683`). The professor
agent decides *which lecture unit* plays next but cannot touch floor state.

---

## 2. SHARED STATE (server)

`NcipRoom` instance per room (`ncipRoom.mjs:41–125`). Exact fields:

| Field | Type | Meaning | Init |
|---|---|---|---|
| `roomId` | string | room id | ctor arg `:42` |
| `roomType` | `'public'\|'private'` | admission model | `'public'` `:46` |
| `floor` | `{holder: pid\|null, queue: pid[]}` | exclusive floor owner + FIFO queue | `{holder:null,queue:[]}` `:47` |
| `professor` | `{status}` | professor state machine | `{status: IDLE}` `:48` |
| `interruption` | `{checkpoint, pauseReason}` | canonical checkpoint + `'host'\|null` | both null `:51–57` |
| `participantCheckpoints` | `Map<pid,cp>` | per-learner pause checkpoints | empty `:65` |
| `currentAnswer` | `{id,startedAt,durationMs,text,audioUrl,lipsync,animation,facialExpression}\|null` | in-flight floor answer | null `:68` |
| `lectureActive` | bool | lecture playing flag | false `:69` |
| `lectureProgress` | object | V2 pedagogical progress (topics, transitions, interaction history ≤20, groupRecap) | `:73–83` |
| `playback` | `{lectureId,segmentIndex,playbackOffsetMs,language,reportedAt}\|null` | live playback position reported by clients | null `:87` |
| `recapAnchors` | `Map<pid,{lectureId,segmentIndex,playbackOffsetMs,satisfied}>` | first-join position for "Catch Me Up" | empty `:93` |
| `language` | `{roomLanguage}` | **one room-wide language** | `{roomLanguage:'en'}` `:95` |
| `FLOOR_TIMEOUT_MS` | number | floor-question deadline | `30_000` `:100` |
| `floorDeadline` | `{holder,expiresAt}\|null` | armed only while PAUSED post-checkpoint | null `:101` |
| `THINKING_TIMEOUT_MS` | number | answer-generation deadline | `60_000` `:105` |
| `thinkingDeadline` | `{holder,token,expiresAt}\|null` | armed per question (`gen<N>` token) | null `:106` |
| `_marks` | object | metric timestamps | `{}` `:109` |
| `session` | `{participants: Map<pid,{connected,socketId,joinedAt,disconnectedAt}>}` | stable participant registry | `:115` |
| `RECONNECT_GRACE_MS` | number | disconnect grace window | `10_000` or `EVAL_RECONNECT_GRACE_MS` `:118–119` |
| `_graceDeadlines` | `Map<pid,epochMs>` | per-participant grace expiry | `:120` |
| `stateVersion` | int | monotonic authoritative version | `0` `:124` |

**stateVersion**: incremented by `_bump()` (`:127–129`) on every
protocol-state mutation — floor grant/queue/release/cancel, checkpoint
accept, question submit, answer ready/finish/fail, language change,
participant join/reconnect/disconnect-expiry, lecture end, host pause.
It is **per room**, present in `floor-state` and `session.snapshot`
(`:359`), and carried on NCIP events; clients classify each event as
stale/apply/gap (`ncipSync.js:17–27`). Deliberately **not** bumped for
avatar movement, chat, or agent segment advances (`:122–124`, `:546–551`).

**Snapshot** (`snapshot()`, `:346–396`): `{stateVersion, floor{holder,queue},
professor{status}, lecture{active,lectureId,segmentIndex,playbackOffsetMs,
language,unit}, interruption{checkpoint,pauseReason}, language{roomLanguage},
lectureProgress, session{participants}, currentAnswer, serverNow}` —
enriched server-side with `language.myLanguage`, `canCatchUp`, `room`,
named floor entries, `mic.permissions` (`server.js:1940–1963`).

---

## 3. PERSONAL STATE (client only)

| Field | Where | Server sees it? |
|---|---|---|
| `participantId` (stable, sessionStorage `nexoraxr_participant_id`) | `src/nexora_client/src/shared/config.js`; sent in `join` (`Scene.jsx:1966`) | **yes** — becomes the room key (`ncipRoom.mjs:150`) |
| `displayName` (sessionStorage) | `Scene.jsx:40,684–687` | yes (display only) |
| `lectureLang` / `lectureLangRef` — my audio language | `Scene.jsx:923,926` | only via `language.mine` request and the checkpoint's `language` field |
| `myLangOverrideRef` — I chose my own language | `Scene.jsx:1094` | no (client-side flag) |
| Playback position — single `<audio>` element `audioElementRef`, `currentTime`, `resumeAt` per message | `useSpeech.jsx:23,302` | reported at segment boundaries (`professor-speak` echo `Scene.jsx:1960` → `ncip.updatePlayback` `ncipRoom.mjs:481`) and inside checkpoints |
| Sentence index / fraction inside sentence | computed transiently (`Scene.jsx:1660–1674`); stored in `localResumeCpRef` (`:935,1676–1683`) | yes — inside `lecture-checkpoint` / `lecture-checkpoint-mine` payloads |
| Message queue (`messages`, `messagesRef`) | `useSpeech.jsx:12,26–27` | no |
| `floorPausedRef` / `floorPaused` | `useSpeech.jsx:28–29` | no |
| `localResumeCpRef` — my own pause checkpoint | `Scene.jsx:935` | no (local-first resume) |
| `chatOpen`, `scriptSeed`, `transcriptEpoch`, `lectureScript`, `maxSegRef` | `Scene.jsx:872,996,2016–2024` | no |
| Clock offset (`lectureClock.js:7–8`) | client module | via `time.ping/pong` only |
| Voice-chat (WebRTC) state | `useVoiceChat` | signaling only |

Server stores per-participant data only in `session.participants`
(connected/joinedAt/disconnectedAt, `:115`), `participantCheckpoints`
(`:65`), `recapAnchors` (`:93`), `rooms[r][p].lang` (`server.js:2540`),
and `questionRate` (`server.js:2124`).

---

## 4. STATE MACHINE

### Professor states (`ProfessorStatus`, `ncipRoom.mjs:9–16`)

`IDLE`, `LECTURING`, `PAUSED`, `THINKING`, `ANSWERING`, `RESUMING`.
(`RESUMING` is transient — set inside `_advanceFloor`/`hostResume` and
immediately overwritten to `LECTURING`/`IDLE` in the same synchronous
block, `:455–460`, `:713–718`.)

### Transition table

| From | Event (method) | Guard | To | Side effects | file:line |
|---|---|---|---|---|---|
| IDLE | `updatePlayback` (first segment report) | valid pos, `acceptsLectureReport` | LECTURING | `floor-state` | `ncipRoom.mjs:481–508`, server `server.js:2790` |
| IDLE | `lectureUnitStarted` (dynamic unit) | — | LECTURING | `floor-state` | `ncipRoom.mjs:654–662` |
| any | `requestFloor` (floor free) | `pauseReason!=='host'`; not already holder/queued | PAUSED | bump; `floor-state` + `pause-for-floor{activeSpeaker}` | `ncipRoom.mjs:767–785` |
| any (floor held) | `requestFloor` (queued) | same guards | unchanged | bump; `floor-state` | `ncipRoom.mjs:794–796` |
| PAUSED | `submitCheckpoint` (holder's first report) | `floor.holder===userId`; no checkpoint yet | PAUSED | bump; checkpoint stored; `floorDeadline=now+30s`; `floor-ready`→holder + `floor-state` | `ncipRoom.mjs:861–890` |
| PAUSED | `submitQuestion` | holder; checkpoint exists; status PAUSED | THINKING | bump; `floorDeadline=null`; `thinkingDeadline={gen<N>,now+60s}`; `lecture-control{action:'thinking'}` | `ncipRoom.mjs:946–980` |
| THINKING | `answerReady` | status THINKING | ANSWERING | bump; `currentAnswer`; `professor-speak{floorAnswer:true}` | `ncipRoom.mjs:982–1008` |
| THINKING | `answerFailed` | status THINKING | → `_advanceFloor` | `floor-question-error`→asker, `answer-error`, release holder, grant next or resume | `ncipRoom.mjs:1012–1024` |
| THINKING | `thinkingTimeoutExpired` | same token, deadline passed | → `answerFailed` | same as answerFailed | `ncipRoom.mjs:837–845` |
| ANSWERING | `answerEnded` | status ANSWERING; id matches; ≥50% duration elapsed | → `_finishAnswer`→`_advanceFloor` | `answerEnd` mark; next holder PAUSED+pause-for-floor, or RESUMING→`resume` broadcast | `ncipRoom.mjs:1047–1053`, `:1026–1031` |
| ANSWERING | `answerTimeExpired` | status ANSWERING; id matches | same | server-side timer path | `ncipRoom.mjs:1036–1040` |
| ANSWERING | `releaseFloor` (holder gives up mid-answer) | holder | ANSWERING (holder=null) | bump; `floor-state` | `ncipRoom.mjs:807–818` |
| PAUSED (floor) | `releaseFloor` | holder | → `_advanceFloor` | next holder or resume | `ncipRoom.mjs:809–810` |
| PAUSED (floor) | `floorTimeoutExpired` | same holder; deadline passed | holder=null → `_advanceFloor` | next or resume | `ncipRoom.mjs:824–833` |
| PAUSED/THINKING/ANSWERING | `disconnect(holder)` | holder dropped | holder=null; THINKING/ANSWERING let answer finish | `_advanceFloor` (PAUSED) or `floor-state` | `ncipRoom.mjs:1057–1079` |
| queue | `cancelRequest` | in queue | unchanged | bump; `floor-state` | `ncipRoom.mjs:799–805` |
| queue | `disconnect(queued)` / `expireGrace` | queued | removed from queue | bump; `floor-state` | `ncipRoom.mjs:1059–1064`, `:264–278` |
| LECTURING | `hostPause` (private/host) | status LECTURING; position resolvable | PAUSED (`pauseReason:'host'`) | checkpoint from `_effectivePosition`; `pause-for-host` | `ncipRoom.mjs:673–703` |
| PAUSED(host) | `hostResume` | `pauseReason==='host'` | RESUMING→LECTURING/IDLE | `resume` broadcast | `ncipRoom.mjs:705–720` |
| any | `changeLanguage` | language ∈ `SUPPORTED_LANGUAGES`; ≠ current | unchanged status | bump; `language-change` + `floor-state`; checkpoint/playback language retargeted | `ncipRoom.mjs:909–941` |
| LECTURING/… | `endLecture` / `startLecture` | — | IDLE (or reset) | clears floor, queue, checkpoints, answers, anchors, progress | `ncipRoom.mjs:725–763`, `:517–531` |

**Transitions the code can take that are NOT "normal":**
- `requestFloor` while a *host* pause is active → silently ignored
  (`ncipRoom.mjs:770`).
- `submitCheckpoint` from a non-holder or a second time → ignored
  (`:862–863`).
- `answerEnded` with wrong id or <50% elapsed → ignored (`:1049–1051`).
- `floorTimeoutExpired`/`thinkingTimeoutExpired` stale firings → no-op
  (`:826–829`, `:838–841`).
- `disconnect` of THINKING/ANSWERING holder keeps status; the answer
  completes for the room (`:1072–1078`).
- Eval mutants M1/M1b/M2/M3/M4 (`:37`, `:446–448`, `:780–793`, `:270–276`,
  `:951`) — dormant unless `EVAL_MUTANT` set.
- `lecture-segment-ended` accepted only while LECTURING with matching
  `run.currentUnit.id` (`server.js:2935–2947`).

**Terminal:** `endLecture` → `IDLE`, `lectureActive=false` (`:725–763`),
triggered by `lecture-ended` socket event (`server.js:2849`), host
`lecture-control{action:'end'}` (`server.js:2834`), lecture queue drain, or
`startLecture` reset (`:517–518`).

---

## 5. EVENTS AND MESSAGES

Direction: C→S = client emits; S→room = server broadcasts; S→C = directed.

| Event | Dir | Payload | Who may send | Server validation | file:line |
|---|---|---|---|---|---|
| `join` | C→S | `{roomId,room,invite,participantId,guestToken,name,avatar,position,rotation,animation}` | anyone | name ≤30 chars; private rooms need invite + host approval; `resolveParticipantId` | `Scene.jsx:1966`; `server.js:2312–2369`, `:2180–2307` |
| `self-info` | S→C | `{participantId,guest,user}` | — | — | `server.js:2300` |
| `session.snapshot` | S→C | full snapshot (§2) | — | `snapshotIsStale` client-side | `server.js:2297`; `Scene.jsx:1837` |
| `session.sync` | C→S | none | member | membership | `Scene.jsx:1378`; `server.js:2450` |
| `request-floor` | C→S | none | participant | `socketIsParticipant`; host-pause blocks | `Scene.jsx:2067,2084,2297`; `server.js:2547`; `ncipRoom.mjs:767` |
| `cancel-floor-request` | C→S | none | participant | in-queue check | `Scene.jsx:2067`; `server.js:2558`; `ncipRoom.mjs:799` |
| `release-floor` | C→S | none | participant | must be holder | `Scene.jsx:2065`; `server.js:2568`; `ncipRoom.mjs:807` |
| `floor-state` | S→room | `{floorQueue,activeSpeaker,professorStatus,stateVersion}` | — | — | `ncipRoom.mjs:23`; `Scene.jsx:1388` |
| `floor-ready` | S→C(holder) | `{userId}` | — | emitted by `submitCheckpoint` | `ncipRoom.mjs:889` |
| `lecture-checkpoint` | C→S | `{lectureId,language,segmentIndex,playbackOffsetMs,sentenceIndex,slidePage,slideDoc}` | participant (effectively holder-only) | holder only; first write wins | `Scene.jsx:1711`; `server.js:2580`; `ncipRoom.mjs:861` |
| `lecture-checkpoint-mine` | C→S | `{lectureId,segmentIndex,sentenceIndex,fractionWithinSentence}` | participant | int segmentIndex ≥0 | `Scene.jsx:1684`; `server.js:2595`; `ncipRoom.mjs:425` |
| `ask-floor-question` | C→S | `{question,lectureId}` or `{kind:'recap',question,lectureId}` | participant | holder+PAUSED+checkpoint via `submitQuestion`; rate limit 1/4s/pid; question ≤500 chars | `Scene.jsx:1417,2081,2291`; `server.js:2605–2634`; `ncipRoom.mjs:946` |
| `thinking` | S→room (lecture-control) | `{askedBy:{userId},question}` | — | — | `ncipRoom.mjs:973` |
| `answer-ended` | C→S | `{id,audioMs}` | ctx | id match; ≥50% duration | `Scene.jsx:1915`; `server.js:2734`; `ncipRoom.mjs:1047` |
| `floor-question-error` | S→C | `{error}` | — | — | `ncipRoom.mjs:1017` |
| `professor-speak` | S→room | `{id,text,audioUrl,lipsync,animation,facialExpression,floorAnswer?,durationMs?,type?,lectureId?,slidePage?,slideDoc?,stateVersion?,unitStartedAt?}` | agent/host | segment reports → `updatePlayback` only | `ncipRoom.mjs:1001`; `Scene.jsx:1477`; `server.js:2771–2810` |
| `lecture-segment-ended` | C→S | `{lectureId,segmentId,messageId}` | participant | only while LECTURING; matching `run.currentUnit.id`; dedup `completedIds` | `Scene.jsx:1935`; `server.js:2928–2972` |
| `lecture.start` | C→S | `{lectureId}` | participant (STUDENT blocked; private=host) | id regex; readiness gate; `acceptLectureStart` dedup | `Scene.jsx:1070`; `server.js:2865–2916` |
| `lecture-started` | S→room | `{lectureId,…}` | — | — | `server.js:1666` |
| `lecture-complete` | S→room | `{reason}` | — | — | `Scene.jsx:1545` |
| `lecture-ended` | C→S | none | participant (private=host) | membership | `server.js:2849` |
| `lecture-control` | S→room | `{action:'pause-for-floor'|'resume'|'thinking'|'answer-error'|'language-change'|'language-mine'|'language-error'|'pause-for-host'|'end'|'control-error',…}` | — | — | `ncipRoom.mjs:38,414,700,932,973,1018`; `Scene.jsx:1620` |
| `lecture-control` | C→S | `{action:'pause'|'resume'|'end'}` | participant + owner/INSTRUCTOR/SUPER_ADMIN | role check | `Scene.jsx:2253`; `server.js:2813–2846` |
| `language.mine` | C→S | `{language}` | participant | `LANGUAGE_CODES`; readiness gate | `Scene.jsx:1097`; `server.js:2514–2544` |
| `language-mine` | S→C | `{language,segmentIndex?}` | — | — | `server.js:2543` |
| `language.change` | C→S | `{language}` | host/INSTRUCTOR/SUPER_ADMIN | readiness gate all segments | `server.js:2459–2509` |
| `language-change` | S→room | `{language,segmentIndex}` | — | — | `ncipRoom.mjs:932` |
| `language-error` | S→room | `{error}` | — | — | `server.js` language handlers |
| `chat` | C→S→others | `{from,text}` | ctx member | none (no rate limit) | `server.js:2976–2981` |
| `state-update` | C↔S | `{avatar?\|name?\|position?\|rotation?\|animation?}` | member | name ≤64 chars | `Scene.jsx:669,721,2011`; `server.js:2752` |
| `webrtc-signal` | C→S→target | `{from,data}` | ctx member | target in room | `Scene.jsx` (useVoiceChat); `server.js:2986` |
| `mic.request/decision/revoke/release` + `mic-state/requested/granted/denied/revoked` | C↔S | `{userId,grant}` etc. | member / host-or-admin | `canModerateMic` | `Scene.jsx:2059,2234`; `server.js:3002–3042` |
| `time.ping`/`time.pong` | C↔S | `{t0,now}` | member | none | `lectureClock.js:17–27`; `server.js:2446` |
| `leave` | C→S | none | member | — | `server.js:2426` |
| `disconnect` | S-side | — | socket drop | grace window | `server.js:3048–3070` |
| `private-join-request`/`private-join-decision`/`join-pending`/`join-error`/`room-kicked`/`session-taken-over`/`auth-error`/`guest-session`/`spawn-position`/`room-state`/`user-joined`/`user-left`/`mic-state` | various | room membership | — | — | `server.js:2180–2439`; `Scene.jsx:1297–1464` |

**Late join:** on `join`, `finishJoin` emits `session.snapshot`
(`server.js:2297`) plus `floor-state`, `mic-state`, `room-state`,
`spawn-position`, `self-info` (`:2287–2306`). The client converges via
`planLectureRecovery` / `planAnswerRecovery` (`ncipSync.js:57–129`,
`Scene.jsx:1879–1905`). A first-time mid-lecture joiner is recorded for
group recap (`ncipRoom.mjs:617–631`; `canCatchUp`/`recapRange` `:225–247`).

---

## 6. FLOOR CONTROL RULES

- **Grant when free:** `requestFloor` with `floor.holder===null` → holder =
  requester, status → PAUSED, bump, broadcast `floor-state` +
  `pause-for-floor{activeSpeaker}` (`ncipRoom.mjs:775–784`). The lecture
  pauses **at grant time**, broadcast to the whole room.
- **Queue when held:** `floor.queue.push(userId)` FIFO
  (`ncipRoom.mjs:794–796`); next holder = `queue.shift()` (`:448`) —
  FIFO by **server arrival order** (the queue is a plain array; order is
  socket-event arrival at `requestFloor`).
- **Duplicates:** a request from the current holder or an already-queued
  pid is silently ignored — never duplicated, never moved
  (`ncipRoom.mjs:771–773`).
- **Cancel:** yes — `cancel-floor-request` removes the pid from the queue
  (`ncipRoom.mjs:799–805`). The holder cannot "cancel" — only `release-floor`.
- **Early release:** `releaseFloor` while PAUSED → `_advanceFloor`
  (next queued or resume); while THINKING/ANSWERING the holder is dropped
  but the answer still completes (`ncipRoom.mjs:807–818`).
- **What ends a turn:** (a) `answer-ended` from the first client whose
  audio finished (id must match, ≥50% of measured duration elapsed,
  `ncipRoom.mjs:1047–1053`); (b) server `answerTimeExpired` at
  `durationMs + ANSWER_END_SLACK_MS(2000)` or `ANSWER_END_UNKNOWN_MS(15000)`
  (`server.js:1992–1993,2008`); (c) `release-floor`; (d) holder disconnect;
  (e) floor timeout — **30 s** from checkpoint acceptance to question
  submit (`FLOOR_TIMEOUT_MS`, `ncipRoom.mjs:100,884`; server `syncFloorTimer`
  `server.js:2034`); (f) THINKING timeout — **60 s** generation deadline
  (`THINKING_TIMEOUT_MS`, `ncipRoom.mjs:105,964–968`).
- **Professor agent failure/timeout mid-answer:** generation failure or
  the 60 s thinking timeout → `answerFailed` → `floor-question-error` to
  the asker + `answer-error` broadcast, holder released, next queued
  student granted or lecture resumes from checkpoint
  (`ncipRoom.mjs:1012–1024,837–845`).

---

## 7. LECTURE PAUSE / RESUME AND CHECKPOINTS

- **When the lecture pauses:** at **floor grant** — `pause-for-floor` is
  emitted inside the same effect batch as the grant (`ncipRoom.mjs:784`),
  i.e. when the floor is *taken*, before any question exists. Broadcast to
  the whole room. Each client calls `pauseLectureForFloor()` which pauses
  its own audio element and returns its position (`useSpeech.jsx:295–315`,
  `Scene.jsx:1652–1654`). Host pauses use `pause-for-host`
  (`ncipRoom.mjs:700`, `Scene.jsx:1622`).
- **Canonical checkpoint** (holder only, first write wins):
  `{lectureId, segmentIndex, playbackOffsetMs, sentenceIndex, slidePage,
  slideDoc, language, reportedBy, reportedAt}` — `ncipRoom.mjs:865–880`,
  emitted by `Scene.jsx:1711` only `if isActiveSpeaker`-equivalent
  (holder's `pause-for-floor` with `isActiveSpeaker`). Stored in
  `interruption.checkpoint`; projected into `session.snapshot`
  (`:384`) and the `resume` broadcast (`:416`).
- **Per-learner checkpoints (the sentence fix): IMPLEMENTED** on
  `eval-floor` @ `e2fb32e` (local-first) building on `4927091`
  (server-side store). Every client emits `lecture-checkpoint-mine`
  `{lectureId, segmentIndex, sentenceIndex, fractionWithinSentence}` on
  pause (`Scene.jsx:1684`); the server stores it per pid
  (`ncipRoom.mjs:425–437`) and includes `perCheckpoints` in the `resume`
  broadcast (`:406–418`). On resume each client prefers **its own local
  record** (`localResumeCpRef`, `Scene.jsx:935,1676–1683`): raw
  `playbackOffsetMs` when the language never changed (exact position),
  otherwise sentence index + fraction re-grounded through the *current*
  language's `sentences[]` (`Scene.jsx:1731–1784`). Server per-pid entry
  is used only when no local record exists (reconnect); room checkpoint is
  the logged fallback; missing sentence data falls back to segment start
  (`Scene.jsx:1745–1755`).
- **Resume target today:** each learner resumes at their **own** paused
  sentence + intra-sentence fraction in **their own language** — not
  merely the sentence start (the fraction is preserved). Same-language
  resume is bit-exact via raw offset.
- **Sentence alignment across languages:** built offline per language by
  `scripts/bake_alignment.py` (Whisper word timestamps + known script
  sentence boundaries snapped to inter-word pauses →
  `lecture_cache/segments/<lecture>__<lang>/alignment.json`,
  `{i,start,end,snapped}`). Served per segment as `sentences[]` by
  `loadLectureManifest` (`lectureRoutes.mjs:476–485,557–559`). **Sentence
  counts are NOT required to match across languages** — each language's
  alignment is computed independently from its own text; the client maps
  old-language offset → sentence index → new-language
  `sentences[min(si,len-1)].start` (`Scene.jsx:1149–1168`), a best-effort
  positional mapping that degrades to segment restart when data is absent.
- **Segment boundaries:** **no barrier** — each client advances its own
  audio queue on its local `ended` event and reports
  `lecture-segment-ended` (`useSpeech.jsx:234–251`, `Scene.jsx:1935`); the
  server accepts the report matching `run.currentUnit.id` and advances
  (`server.js:2928–2972`) without waiting for other clients. **Two learners
  can absolutely be in different segments** (faster-language audio pulls
  the room forward; slower clients trail — measured in the resume eval:
  baseline same-sentence rate fell to ~35% at N=4).

---

## 8. DISCONNECTION AND RECOVERY

- **Detection:** Socket.IO defaults — **no** `pingInterval`/`pingTimeout`/
  `connectionStateRecovery` configured (`server.js:1478–1484`); defaults
  25 s/20 s apply (INFERRED from socket.io defaults — not set in code).
  App-level keepalive is `time.ping`/`time.pong` every 5 s
  (`lectureClock.js:25–27`, `server.js:2446–2448`).
- **RECONNECT_GRACE_MS = 10 000** (`ncipRoom.mjs:118–119`), env override
  `EVAL_RECONNECT_GRACE_MS` (eval-only). On `disconnect`,
  `participantDisconnected` marks the pid offline and arms
  `_graceDeadlines[pid] = now + 10 s` (`:251–259`); server sets a
  `setTimeout` to `expireGrace` (`server.js:3061–3070`).
- **Recognition:** stable client-supplied `participantId`
  (sessionStorage) resolved by `resolveParticipantId`
  (`server.js:2130–2147`); `joinParticipant` rebinds the pid to the new
  socket and clears the grace deadline (`ncipRoom.mjs:150–174`).
- **Floor holder disconnects:** during grace the holder/queue are
  preserved (`disconnect()` is only called at expiry,
  `ncipRoom.mjs:264–278`). Rejoin within grace → `reconnected:true`, floor
  intact. On expiry → `expireGrace` → `disconnect(pid)`: queued pids are
  removed; a PAUSED holder's floor advances to the next queued student or
  the lecture resumes (`ncipRoom.mjs:1057–1079`). A THINKING/ANSWERING
  holder's answer still completes for the room.
- **Queued learner disconnects:** removed from `floor.queue` at grace
  expiry (or immediately on explicit `leave`/kick,
  `ncipRoom.mjs:1059–1064,281–287`).
- **Checkpoint restore on reconnect:** yes — `participantCheckpoints`
  survives the socket drop ("the map outlives the participant's socket",
  `ncipRoom.mjs:58–65`) and is included in the next `resume` broadcast;
  the rejoined client also receives `session.snapshot` with the canonical
  position. Entry deleted only on `expireGrace`/`leave`/`endLecture`
  (`:269,283,737`).

---

## 9. MULTILINGUAL AND PERSONAL ACTIONS

- **Supported languages:** `en, ar, fr, de, es, zh` —
  `src/shared/languages.mjs:17–30` (`hi` deliberately excluded, comment
  `:14–15`).
- **Answer language:** the professor agent emits lecture units **per
  language group** (`server.js:1786–1810`) and floor answers via `/api/ask`
  which validates `LECTURE_LANGUAGES` (`lectureRoutes.mjs:898–905`) —
  i.e. the answer is generated in the **room language** (or the asker's
  language where applicable). Per-listener translated/TTS answers:
  **NOT IMPLEMENTED** as a per-socket fan-out; each listener hears the
  broadcast answer in the language it was generated.
- **Language switch mid-lecture:** client emits `language.mine`
  (`Scene.jsx:1097`); server acks `language-mine` to that client only
  (`server.js:2543`) → client rebuilds its own queue from the
  authoritative `segmentIndex` hint (`ncipSync.js:163–171`,
  `Scene.jsx:1107–1183`) preserving position via sentence alignment
  (`Scene.jsx:1149–1168`). **Does not affect other learners.**
- **Room-wide language change:** host/INSTRUCTOR/SUPER_ADMIN emits
  `language.change` (`server.js:2459`); `ncip.changeLanguage` retargets
  the canonical checkpoint/playback language and broadcasts
  `language-change{language,segmentIndex}` to everyone
  (`ncipRoom.mjs:909–941`); an in-flight ANSWERING answer finishes in its
  original language (`:907–908` comment).
- **Language switch while paused:** allowed — the checkpoint's `language`
  field is retargeted on `changeLanguage` (`ncipRoom.mjs:918–920`); for a
  personal `language.mine` during pause the client rebuilds locally and
  its pause record re-grounds through the new manifest at resume
  (`Scene.jsx:1731–1756`). Measured: 86–93% exact in extras.
- **Side chat (ChatGPT): NOT IMPLEMENTED** as a product feature. What
  exists: a room-wide `chat` broadcast (`server.js:2976–2981`, no
  persistence/rate-limit, never bumps `stateVersion`), the
  `ChatInterface` transcript + floor-question panel
  (`Scene.jsx:2273–2300`, `components/ChatInterface.jsx`), and WebRTC
  voice signaling (`webrtc-signal`, `server.js:2986`). No side-chat event
  touches floor or shared protocol state. No config flag disables chat —
  **NOT IMPLEMENTED**.

---

## 10. UI SIGNALS SHOWN TO LEARNERS

- **Floor holder shown:** yes — `activeSpeaker`/`floorHolder` rendered as
  `"<name> has the floor"` in `ChatInterface.jsx:362–368,399–400`; a
  holder-change toast `"<name> is asking a question"` (`Scene.jsx:1391–1399`,
  rendered `:2267–2271`); avatar raised-hand visuals via `raisedHands`
  (`Scene.jsx:2091`).
- **Queue position ("you are #N"): NOT IMPLEMENTED.** `floorQueue` is
  passed to `ClassroomPanel` (`Scene.jsx:2222`) but used only to derive
  `handRaised`/`isActiveSpeaker` booleans (`Scene.jsx:2045,2047`) and the
  button label `'Release Floor'|'Lower Hand'|'Raise Hand'`
  (`Scene.jsx:173,204–225`). No ordinal position is displayed anywhere.
- **"You're next" signal:** NOT IMPLEMENTED (no queue-head indicator
  distinct from being holder).
- **Raise-hand states:** `handRaised` (queued) → amber hand + "Hand is
  raised"; `isActiveSpeaker` (holder) → emerald + "You have the floor" +
  button becomes "Release Floor" (`Scene.jsx:204–225`). Guests cannot
  raise (`:204` `if (!isGuest)`).
- Host controls: Start/Pause/Continue/Stop Lecture buttons
  (`Scene.jsx:156–171,430–503`) gated by `canEndLecture`/`isRoomHost`
  (`:762–770`); mic approve/deny/revoke (`:340–358`); kick
  (`:359–366`); private-join accept/decline (`:2120–2151`).

---

## 11. OTHER FEATURES

| Feature | Status |
|---|---|
| Late join mid-lecture | **Implemented** — snapshot + `planLectureRecovery`/`planAnswerRecovery` (`server.js:2297`; `ncipSync.js:57–129`; `Scene.jsx:1837–1905`) |
| Recap of missed content | **Implemented (V1, public rooms only)** — `recapAnchors`, `canCatchUp`, `recapRange` (`ncipRoom.mjs:93,225–247`); "Catch Me Up" button (`Scene.jsx:2075–2086,229–241`); `/api/recap` (`lectureRoutes.mjs:1080`) |
| Teacher/facilitator controls | **Implemented** — host pause/resume/end, room language change, mic moderation, kick, invite management (§5, §10) |
| Multiple rooms | **Implemented** — `roomRegistry.mjs`, public scene rooms + private invite rooms (`server.js:257–308,1129–1233`) |
| Authentication | **Implemented** — `nxr_session` cookie via `socketAuth` (`server.js:1487`), `resolveParticipantId` (`:2130`); `NXR_DEV_UNAUTH_PROTOCOL=1` dev bypass (`:56`) |
| Rate limiting | **Partial** — floor questions 1/4 s per pid (`server.js:2124,2626–2632`); HTTP auth endpoints rate-limited (`auth/rateLimit.mjs`); **chat, state-update, webrtc-signal: NOT rate-limited** |

---

## 12. IMPLEMENTATION / ARCHITECTURE

- **Frontend:** React 18.2 + Vite 5.4 (`src/nexora_client/package.json`);
  3D via `@react-three/fiber` 8.15 + `@react-three/drei` 9.93 + `three`
  0.160; XR via `@react-three/xr`; avatars are GLB (`useGLTF`) with
  morph-target viseme lip-sync (`src/nexora_client/src/avatars/Avatar.jsx:1–85`),
  precomputed A2F or spectral modes (`Avatar.jsx:19–22`).
- **Backend:** Node (v22 in dev), Express + **socket.io 4.8.3**
  (`src/nexora_server/package.json`); single `server.js` (~3095 lines)
  hosting REST + Socket.IO; Postgres via `DATABASE_URL` (docker-compose
  `postgres:16`); three deployable units: `nexora_client` (Vite),
  `nexora_server` (Express+socket), `nexora_ai` (FastAPI-adjacent Node
  routes for lecture/TTS/LLM glue).
- **AI services:**
  - **LLM:** Ollama chat (`generateOllama`, `lectureRoutes.mjs:968`;
    `OLLAMA_BASE_URL` env; strong-model fallback `qwen3:8b` for
    translation `:267–299`). Floor answers via `POST /api/ask`
    (`lectureRoutes.mjs:898–1010`) with course RAG context
    (`retrieveCourseContext` `:952`). Professor-agent *decisions* are
    deterministic policy in `agent/professorAgent.mjs` (`decide` `:78`),
    not an LLM call.
  - **RAG:** course context retrieval `retrieveCourseContext`
    (`lectureRoutes.mjs:952`); semantic similarity via
    `multilingual-e5-small` (`src/nexora_ai/scripts/e5_similarity.py`,
    `modules/semanticSim.mjs`).
  - **TTS:** VoxCPM2 over HTTP FastAPI (`ttsClient.mjs:21,131–144`;
    `TTS_URL` default `localhost:8000`), voice registry
    `tts_voices/registry.json`, per-language voice refs
    (`abed101_<lang>`); non-English output Whisper-verified
    (`synthesizeVerified` `ttsClient.mjs:152–216`,
    `modules/langDetect.mjs` → `whisper_service.py`).
  - **Avatar/lip-sync:** precomputed per-segment lipsync JSON
    (`segment_NNN_lipsync.json`) + A2F animation tracks
    (`segment_a2f`, `lectureRoutes.mjs:1578–1632`); real-time spectral
    fallback in `Avatar.jsx:154`.
  - **Side-chat model:** none (see §9).
- **Content preparation:** `profbrain/lectures/<id>/` holds
  `summary.json`, `segments.json` (canonical segment ids/text/document/
  page), `lecture_plan.json` (topics→segments), `slide_map.json`,
  `slides.pdf`/`slides/<doc>.pdf`, `translations/<lang>.json`.
  Pipeline: translate (`drafts.mjs:396–535`, Ollama) → bake audio
  (`courses/bake.mjs:103–148` via `generateSegmentAudio`,
  `lectureRoutes.mjs:324–427`) → bake alignment (`scripts/bake_alignment.py`,
  Whisper) → bake slides (`bake.mjs:154–181`) → readiness gate
  (`protocol/languageReady.mjs:22–82`). Segment audio is **pre-generated**
  per language; only floor answers/recaps/dynamic utterances synthesize
  live.
- **Deployment used for the study:** single-machine dev deployment —
  `docker-compose.yml` (frontend :5173, backend :3000, postgres:16) or
  bare `node server.js` + `vite` + TTS/Whisper/Ollama sidecars; eval runs
  use isolated ports (:4120 server, :5174 vite) with `DATABASE_URL=''`.
  **INFERRED:** the floor/resume benchmarks ran on one workstation, no
  production hosting involved.
- **Protocol module size:** `ncipRoom.mjs` ≈ 1081 lines; client protocol
  helpers `ncipSync.js` 202 + `ncipResume.js` 80 + `lectureClock.js` 29;
  socket wiring concentrated in `Scene.jsx` (~2372 total) and
  `server.js` (~3095 total).

---

## 13. KNOWN DEVIATIONS AND OPEN ISSUES

- **Resume accuracy (fixed, measured):** pre-fix shared-checkpoint resume
  produced same-sentence rates of 35–80% and offset errors up to ~36 s at
  N=4 (multi-language drift + holder-cp drag). Per-learner checkpoints +
  local-first resume (`e2fb32e`, `4927091`) now measure 96.7–100%
  same-sentence, median error 0 ms (`eval/resume/results/`). Residual:
  ~3% fallbacks when a client's `checkpoint-mine` misses the fast mock
  answer's serialization window (now moot for the normal path since the
  local record needs no round-trip) and sentence-tail fraction clamps in
  the switched-language path.
- **No segment barrier:** clients in different segments at pause time is
  *expected* protocol behaviour, not a bug — but it is the root cause the
  per-learner checkpoint fix addresses.
- **Starvation case (D2, N=2):** per `eval/floor/results/grace/GRACE_SWEEP.md`
  — no protocol starvation found; 200+ replayed rooms showed every
  requester eventually granted; the original failure was classified
  **transient, harness-side** (socket-level failure class, same as the
  timed-out C_n2 reps which were `websocket error` in `Student.connect`).
- **Timed-out rep (exploratory run):** `floor_C_n2` reps 28–29 failed in
  `connect()` — harness/environment, not NCIP; 100/100 replay finished.
- **Working tree:** clean at `3395164`.
- **Eval-only switches present in production code paths:**
  `EVAL_MUTANT` (`ncipRoom.mjs:37`), `EVAL_RESUME_LEGACY` (`:405`),
  `EVAL_RECONNECT_GRACE_MS` (`:118`), `NXR_DEV_UNAUTH_PROTOCOL`
  (`server.js:56`), `EVAL_MOCK_PROFESSOR` (`lectureRoutes.mjs:910`) — all
  dormant unless set.
- **Not implemented / partial:** queue-position UI (§10), per-listener
  answer language (§9), side-chat product (§9), socket-level rate limits
  on chat/state-update (§11), Socket.IO keepalive tuning (§8).

---

## Summary table

| Requirement | Implemented | file:line |
|---|---|---|
| Exclusive floor | yes | `ncipRoom.mjs:767–797` |
| FIFO queue | yes (server arrival order) | `ncipRoom.mjs:794–796,448` |
| Duplicate suppression | yes (ignore, no reorder) | `ncipRoom.mjs:771–773` |
| Cancel request | yes | `ncipRoom.mjs:799–805`; `server.js:2558` |
| Pause at grant for all | yes | `ncipRoom.mjs:784`; `Scene.jsx:1652` |
| Per-learner sentence checkpoint | yes | `ncipRoom.mjs:58–65,425–437`; `Scene.jsx:1684` |
| Resume at own sentence+fraction | yes (local-first; raw offset same-lang) | `Scene.jsx:935,1676–1784`; commits `4927091`,`e2fb32e` |
| Shared versioned state broadcast | yes | `ncipRoom.mjs:124–129,346–396`; `ncipSync.js:17–27` |
| Language switch isolated | yes (`language.mine` per-learner) | `server.js:2514`; `Scene.jsx:1097,1107` |
| Side chat isolated | yes (chat never touches protocol state; no side-chat feature) | `server.js:2976–2981`; `ncipRoom.mjs:122–124` |
| Grace window | yes (10 s, env override) | `ncipRoom.mjs:118–119,251–278`; `server.js:3048–3070` |
| Checkpoint restore on reconnect | yes | `ncipRoom.mjs:58–65,269`; `Scene.jsx:1759–1778` |
| Queue position shown in UI | **no** | `Scene.jsx:2045,2222` (only booleans derived) |
| Per-listener answer language | **no** (room-language answer broadcast) | `lectureRoutes.mjs:898–905`; `server.js:1786–1810` |
