// Session plumbing shared by Express and Socket.IO.
//
// The session is an opaque bearer token in an HttpOnly cookie — the same
// credential authenticates HTTP requests and the Socket.IO handshake.
// resolveSession() joins users so deactivated accounts fail immediately.

import { resolveSession } from './passwordless.mjs';
import { dbAvailable } from '../db/pool.mjs';

export const SESSION_COOKIE = 'nxr_session';

export function parseCookies(header) {
  const out = {};
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function sessionCookieHeader(token, expiresAt, secure = false) {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'HttpOnly', 'Path=/', 'SameSite=Lax',
    `Expires=${new Date(expiresAt).toUTCString()}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export const clearCookieHeader = (secure = false) =>
  `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0` + (secure ? '; Secure' : '');

// Express middleware: attaches req.user when a valid session cookie exists.
// Never rejects — authorization decisions belong to requireAuth/requireRole.
export async function attachUser(req, _res, next) {
  req.user = null;
  if (dbAvailable()) {
    try {
      const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
      if (token) req.user = await resolveSession(token);
    } catch { /* session lookup failure = unauthenticated, not a 500 */ }
  }
  next();
}

// Socket.IO handshake middleware: same cookie, same lookup. Guests are
// allowed to connect — socket.data.user stays null and event-level gates
// decide what they may do.
export function socketAuth(io) {
  io.use(async (socket, next) => {
    socket.data.user = null;
    if (dbAvailable()) {
      try {
        const token = parseCookies(socket.handshake.headers?.cookie)[SESSION_COOKIE];
        if (token) socket.data.user = await resolveSession(token);
      } catch { /* unauthenticated socket */ }
    }
    next();
  });
}

export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  next();
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}
