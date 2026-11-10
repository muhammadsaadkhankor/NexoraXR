// Passive socket-only participant for drift/isolation eval runs.
// Joins the room and stays silent — never reports lecture-segment-ended,
// so under the segment barrier it honestly shows up as a lagging client.
// Args: base room pid
import { io } from 'socket.io-client';

const [BASE, ROOM, PID] = process.argv.slice(2);
const s = io(BASE, { transports: ['websocket'] });
s.on('connect', () => {
  // passive: we never play audio — never block the segment barrier.
  s.emit('join', { roomId: ROOM, name: PID, participantId: PID, passive: true });
});
s.on('self-info', () => console.log(JSON.stringify({ event: 'joined', pid: PID })));
s.on('disconnect', () => console.log(JSON.stringify({ event: 'down', pid: PID })));
process.stdin.on('data', (buf) => {
  const cmd = String(buf).trim();
  if (cmd === 'quit') process.exit(0);
});
