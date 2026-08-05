const crypto = require('crypto');

const seen = new Map();
const WINDOW_MS = 60 * 1000;

function clientId(req) {
  const xf = req.headers['x-forwarded-for'];
  if (typeof xf === 'string' && xf.length) return xf.split(',')[0].trim();
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function rateLimit({ windowMs = WINDOW_MS, max = 30 } = {}) {
  return (req, res, next) => {
    try {
      const id = clientId(req);
      const key = `${id}|${req.path}`;
      const now = Date.now();
      const entry = seen.get(key);
      if (!entry || (now - entry.start) > windowMs) {
        seen.set(key, { start: now, count: 1 });
        return next();
      }
      entry.count += 1;
      if (entry.count > max) {
        return res.status(429).json({ error: 'RATE_LIMIT', message: 'Demasiadas solicitudes, intenta en un momento.' });
      }
      return next();
    } catch (e) {
      return next();
    }
  };
}

function idempotencyStore() {
  const map = new Map();
  return (req, res, next) => {
    const key = req.headers['idempotency-key'];
    if (!key) return next();
    const now = Date.now();
    const entry = map.get(key);
    if (entry && (now - entry.at) < 5 * 60 * 1000) {
      try { return res.status(entry.status).json(entry.body); } catch (_) {}
    }
    const origJson = res.json.bind(res);
    res.json = (body) => {
      try { map.set(key, { at: now, status: res.statusCode || 200, body }); } catch (_) {}
      return origJson(body);
    };
    next();
  };
}

module.exports = { rateLimit, idempotencyStore };
