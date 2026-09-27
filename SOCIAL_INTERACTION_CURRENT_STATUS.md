# Social Interaction Current Status

## Scope

This report inspects only the Socket.IO social-interaction features. It does not cover repository layout, assets, TTS, RAG, or unrelated gameplay.

## Current Socket.IO Social-State Flow

1. `socket.on('connection')` in `src/backend/server.js:710`.
2. Client emits `join` from `src/frontend/src/Scene.jsx:360-370` with `roomId`, `name: 'Player'`, `avatar`, `position`, `rotation`, `animation`.
3. Server stores the user in `rooms[roomId][socket.id]` (`src/backend/server.js:731`).
4. Server broadcasts `user-joined` to others and emits `room-state` back to the joiner, excluding the joiner's own socket (`src/backend/server.js:735-737`).
5. Client sends `state-update` for position/rotation/animation (`src/frontend/src/Scene.jsx:384-386`).
6. Server broadcasts `state-update` and `user-left` on disconnect (`src/backend/server.js:751, 767-777`).

There is no display-name entry UI, no raise-hand mechanism, no floor queue, and no active-speaker management.

## Feature-by-Feature Status

| # | Feature | Status | Relevant File / Function |
|---|---|---|---|
| 1 | Student can enter a display name before joining the classroom. | **NOT IMPLEMENTED** | No input component found; `src/frontend/src/Scene.jsx:365` hardcodes `name: 'Player'`. |
| 2 | The display name is sent in the Socket.IO `join` event. | **PARTIAL** | Backend reads `data.name` in `src/backend/server.js:723`; frontend sends a hardcoded `'Player'` from `src/frontend/src/Scene.jsx:365`. |
| 3 | A Raise Hand button exists. | **NOT IMPLEMENTED** | No UI element or event listener found in `src/frontend/src/components/`. |
| 4 | Server keeps a room-level `floorQueue`. | **NOT IMPLEMENTED** | Not present in `src/backend/server.js` `rooms` or socket handlers. |
| 5 | Server keeps `activeSpeaker` state. | **NOT IMPLEMENTED** | Not present in `src/backend/server.js`. |
| 6 | `request-floor` event exists. | **NOT IMPLEMENTED** | No `socket.on('request-floor', ...)` in `src/backend/server.js`. |
| 7 | `cancel-floor-request` event exists. | **NOT IMPLEMENTED** | No `socket.on('cancel-floor-request', ...)` in `src/backend/server.js`. |
| 8 | `floor-state` is broadcast to all users in the room. | **NOT IMPLEMENTED** | No `floor-state` emission in `src/backend/server.js`. |
| 9 | Duplicate floor requests are prevented. | **NOT IMPLEMENTED** | No `floorQueue` to check for duplicates. |
| 10 | Disconnecting users are removed from the queue. | **NOT IMPLEMENTED** | No queue; disconnect handler in `src/backend/server.js:767-777` only removes from `rooms[roomId]`. |
| 11 | All clients can see the ordered list of raised hands. | **NOT IMPLEMENTED** | No `floor-state` listener or UI in `src/frontend/src/`. |

## Recommendation

**The next implementation step should be:** add a server-managed `floorQueue` and `activeSpeaker` map inside `rooms[roomId]` in `src/backend/server.js`, implement `socket.on('request-floor')`, `socket.on('cancel-floor-request')`, and broadcast `floor-state` on every change, then add a Raise Hand button in `src/frontend/src/components/ChatInterface.jsx` that emits `request-floor` and renders the ordered queue.
