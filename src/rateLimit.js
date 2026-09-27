// A small in-memory, fixed-window request limiter (one Node process; see pm2, single fork
// instance, so a shared store like Redis is not needed). Not for the message quotas (those are
// per-day/month/lifetime counts kept in Mongo, see config.js and routes.js) — this is for requests
// that cost no DeepSeek tokens at all (product-code lookups) and so have nothing else standing
// between them and a scripted flood: bursts still cost server time and can scrape the catalogue.

const WINDOW_MINUTE = 60 * 1000;
const WINDOW_HOUR = 60 * WINDOW_MINUTE;

// product-code ("품번") requests: a real person rarely sends more than a few a minute
const PRODUCT_LIST_LIMITS = [
  { windowMs: WINDOW_MINUTE, max: 10 },
  { windowMs: WINDOW_HOUR, max: 100 },
];

const buckets = new Map(); // "<key>|<windowMs>|<bucket index>" -> count this window

/**
 * True (and records the hit) if `key` has not exceeded any of `limits` yet this window; false
 * (nothing recorded) if any window is already at its cap. `key` is whatever identifies the caller
 * (account email when logged in, IP address for an anonymous public endpoint).
 */
function allow(key, limits) {
  const now = Date.now();
  const bucketKeys = limits.map(({ windowMs }) => `${key}|${windowMs}|${Math.floor(now / windowMs)}`);
  for (let i = 0; i < limits.length; i++) {
    if ((buckets.get(bucketKeys[i]) || 0) >= limits[i].max) return false;
  }
  for (const bucketKey of bucketKeys) {
    buckets.set(bucketKey, (buckets.get(bucketKey) || 0) + 1);
  }
  return true;
}

// Buckets from finished windows are never needed again; sweep them out periodically so the map
// doesn't grow forever.
function sweep() {
  const now = Date.now();
  for (const key of buckets.keys()) {
    const at = key.lastIndexOf("|");
    const at2 = key.lastIndexOf("|", at - 1);
    const windowMs = Number(key.slice(at2 + 1, at));
    const bucket = Number(key.slice(at + 1));
    if (bucket < Math.floor(now / windowMs) - 1) buckets.delete(key);
  }
}
const sweepTimer = setInterval(sweep, 10 * 60 * 1000);
sweepTimer.unref(); // never keeps the process alive by itself

const _reset = () => buckets.clear();

module.exports = { allow, sweep, PRODUCT_LIST_LIMITS, WINDOW_MINUTE, WINDOW_HOUR, _reset };
