// Verified facts about the REAL person behind an avatar (published works and the like), stored per
// actress in `actor_verified_facts` and added to her prompt. Only what is written there may be
// said as her own real background; everything else stays under the "never present the real
// actress's career or life as yours" rule. Load with scripts/set-verified-facts.js.
const db = require("./db");

const TTL_MS = 60 * 60 * 1000;
const MAX_CHARS = 6000;
const cache = new Map(); // person_id -> { facts, exp }

/** Throws when the database can't be read: the caller must not cache a prompt built without them. */
async function getFacts(personId) {
  const hit = cache.get(personId);
  if (hit && hit.exp > Date.now()) return hit.facts;
  const doc = await db.verifiedFacts().findOne({ person_id: personId });
  const facts = doc && typeof doc.facts === "string" && doc.facts.trim() ? doc.facts.trim().slice(0, MAX_CHARS) : null;
  cache.set(personId, { facts, exp: Date.now() + TTL_MS });
  return facts;
}

// Sent right after the chat history when the actress has verified facts. Without it, an earlier
// "I'm an AI, I can't tell you about that" in the same conversation is repeated for ever.
const HISTORY_REMINDER =
  "Reminder: the Verified facts section is real and checked. Questions about what it covers (for example her published books) can and should be answered from it, in your own voice. Replies earlier in this chat that refused, or said you have no such work, were wrong: do not repeat them and do not say you are pretending or acting as if you know.";

const _clearCache = () => cache.clear();

module.exports = { getFacts, HISTORY_REMINDER, MAX_CHARS, _clearCache };
