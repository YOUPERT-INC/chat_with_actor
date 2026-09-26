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
  "Reminder: the Verified facts section is real and checked. The user is asking about what it covers (for example her published books): answer from it, in your own voice. Replies earlier in this chat that refused, or said you have no such work, were wrong: do not repeat them and do not say you are pretending or acting as if you know. If you already explained something in this chat, do not retell it: answer only what is new or point back to it in a few words.";

// The reminder is only for turns about these facts: sent every turn it made the avatar drag her
// novels into unrelated answers (a movie recommendation ended with a retelling of a book).
const FACT_WORDS = /소설|책|작가|저서|집필|novel|book|author|writer|小説|書い|著書|作家|小说|书|作品|buku|penulis|roman|книг|роман|писател|นิยาย|หนังสือ|นักเขียน|tiểu thuyết|sách|nhà văn/i;
const normName = (t) => String(t || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** Does the user's message ask about the verified facts (a book title from them, or a word like "novel")? */
function mentionsFacts(text, facts) {
  const t = String(text || "");
  if (FACT_WORDS.test(t)) return true;
  const flat = normName(t);
  for (const m of String(facts || "").matchAll(/^\s*\d+\.\s*「([^」]+)」\s*\(([^,)"]+)/gm)) {
    for (const name of [normName(m[1]), normName(m[2])]) if (name.length >= 2 && flat.includes(name)) return true;
  }
  return false;
}

const _clearCache = () => cache.clear();

module.exports = { getFacts, mentionsFacts, HISTORY_REMINDER, MAX_CHARS, _clearCache };
