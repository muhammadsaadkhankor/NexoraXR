// Shared lecture clock (V2.4): estimates this client's clock offset vs the
// server so professor audio position can be compared against the server's
// unitStartedAt timestamps — converging all clients onto one timeline.
// Offset estimate: serverNow - clientMidpoint (symmetric-RTT assumption);
// the best (lowest-RTT) recent sample wins.

let offsetMs = 0;
let bestRtt = Infinity;

export function getLectureClockOffset() { return offsetMs; }

export function serverTimeNow() { return Date.now() + offsetMs; }

// Call once per socket. Pings every 5s while connected; keeps the
// lowest-RTT offset sample.
export function syncLectureClock(socket) {
  socket.on('time.pong', ({ t0, now }) => {
    const t1 = Date.now();
    const rtt = t1 - t0;
    if (rtt < bestRtt) {
      bestRtt = rtt;
      offsetMs = now - Math.round((t0 + t1) / 2);
    }
  });
  const ping = () => socket.connected && socket.emit('time.ping', Date.now());
  ping();
  const timer = setInterval(ping, 5000);
  return () => clearInterval(timer);
}
