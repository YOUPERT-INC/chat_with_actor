/**
 * Identifies the caller by asking the account server (same call the app makes and the
 * support ChatServer re-verifies: GET https://<host>/api/user/profile with the user's
 * Bearer token). The host is chosen here, never by the client: with a paywall in front of
 * chat, a client-supplied host could point us at a server that answers "subscribed" to
 * anything.
 *
 * The account API is one backend behind several front domains (apiplayer.app, api.flix1.net
 * and the China-side base1/base2 from backup-domain.json all serve the same accounts), so a
 * token from any of them verifies against the first two. This server sits outside the GFW,
 * so it does not need the China-side domains.
 *
 * Membership (chat is a paid feature) = profile.sub_expires_at is in the future. Identity is
 * cached for 10 minutes, but a "no membership" answer is never trusted from the cache: a
 * user who just subscribed must get in on the very next try, so membershipActive() asks the
 * account server again whenever the cached expiry is not in the future.
 */
const crypto = require("crypto");
const axios = require("axios");

// Same values as the app's defaultAuthUrl / backupAuthUrl. Tried in order.
const ACCOUNT_HOSTS = ["apiplayer.app", "api.flix1.net"];

const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 5000;
const cache = new Map(); // sha256(token) -> { email, name, subExpiresAt, exp }

function cacheKey(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function remember(key, value) {
  if (!cache.has(key) && cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value); // oldest first
  cache.set(key, value);
}

// apiplayer.app sends sub_expires_at as epoch milliseconds; tolerate seconds just in case.
function toMillis(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n < 1e11 ? n * 1000 : n;
}

async function defaultFetchProfile(host, token) {
  const resp = await axios.get(`https://${host}/api/user/profile`, {
    headers: { Authorization: `Bearer ${token}` },
    timeout: 10000,
    validateStatus: () => true,
  });
  // server trouble is an error (try the next host); anything else non-200 means "bad token"
  if (resp.status >= 500 || resp.status === 429) throw new Error(`profile HTTP ${resp.status}`);
  return resp.status === 200 && resp.data ? resp.data.data : null;
}

let fetchProfile = defaultFetchProfile;
const _setFetchProfile = (fn) => {
  fetchProfile = fn || defaultFetchProfile;
  cache.clear();
};

async function verify(token, { fresh = false } = {}) {
  const key = cacheKey(token);
  const hit = cache.get(key);
  if (!fresh && hit && hit.exp > Date.now()) return hit;

  let data;
  let lastError = null;
  let answered = false;
  for (const host of ACCOUNT_HOSTS) {
    try {
      data = await fetchProfile(host, token);
      answered = true;
      break;
    } catch (error) {
      lastError = error; // unreachable / 5xx: fall back to the next host
    }
  }
  if (!answered) throw lastError;
  if (!data || typeof data.email !== "string" || !data.email) return null;

  const user = {
    email: data.email.trim().toLowerCase(),
    name: data.name || "",
    subExpiresAt: toMillis(data.sub_expires_at),
    exp: Date.now() + CACHE_TTL_MS,
  };
  remember(key, user);
  return user;
}

async function requireUser(req, res, next) {
  try {
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || "");
    if (!m || m[1] === "null") return res.status(401).json({ error: "LOGIN_REQUIRED" });

    const token = m[1].trim();
    const user = await verify(token);
    if (!user) return res.status(401).json({ error: "LOGIN_REQUIRED" });

    req.user = user;
    req.auth = { token };
    next();
  } catch (error) {
    console.log("[auth] verify failed:", error.message);
    res.status(502).json({ error: "AUTH_UNAVAILABLE" });
  }
}

/**
 * True when the caller's membership is active right now. A cached expiry that is still in
 * the future is trusted (and lapses exactly on time); anything else is re-checked live.
 * Throws if the account server can't be reached (caller answers 502, never "no membership").
 */
async function membershipActive(req) {
  if (req.user.subExpiresAt > Date.now()) return true;
  let fresh;
  try {
    fresh = await verify(req.auth.token, { fresh: true });
  } catch (cause) {
    const error = new Error(`account server unreachable: ${cause.message}`);
    error.code = "AUTH_UNAVAILABLE";
    throw error;
  }
  if (!fresh) return false;
  req.user = fresh;
  return fresh.subExpiresAt > Date.now();
}

module.exports = { requireUser, membershipActive, _setFetchProfile };
