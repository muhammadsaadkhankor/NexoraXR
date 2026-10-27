// Minimal fixed-window rate limiter — in-memory, per-key. Suitable for the
// single-process dev deployment; move to Redis before multi-instance prod.

export function rateLimit({ windowMs, max, keyFn }) {
  const hits = new Map(); // key -> {count, resetAt}
  // Bound memory: sweep occasionally.
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.resetAt < now) hits.delete(k);
  }, windowMs).unref?.();
  return (req, res, next) => {
    const key = keyFn(req);
    const now = Date.now();
    const h = hits.get(key);
    if (!h || h.resetAt < now) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    h.count++;
    if (h.count > max) {
      res.set('Retry-After', String(Math.ceil((h.resetAt - now) / 1000)));
      return res.status(429).json({ error: 'Too many requests. Try again later.' });
    }
    next();
  };
}

export const clientIp = (req) =>
  (req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || '').trim();
