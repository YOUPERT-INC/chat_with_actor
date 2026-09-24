/**
 * Per-actress "character card": a fictional personality, speaking style, favourites and
 * everyday life, generated once from her Korean description and stored in Mongo.
 *
 * Why: the description alone is thin (often just a few facts), so every avatar ended up with the
 * same generic tastes. The card gives each one its own voice and a life to talk about, and it
 * stays byte-identical for every user of that actress, so the prompt prefix cache still applies.
 *
 * The card is invented character material, not facts about the real person. Once made it is
 * FROZEN: a changed Korean description does not touch it, so a running conversation never has
 * its personality or favourites swapped mid-way. It is only made again on purpose, with
 * scripts/regenerate-persona-card.js (source_hash records what it was made from).
 */
const crypto = require("crypto");
const db = require("./db");
const deepseek = require("./deepseek");

const CARD_MIN_CHARS = 300;
const CARD_MAX_CHARS = 2400;
const FAIL_TTL_MS = 10 * 60 * 1000; // don't hammer the model for an actress whose card just failed

const inflight = new Map(); // person_id -> Promise<string|null>
const failedUntil = new Map(); // person_id -> timestamp

const GENERATION_PROMPT = [
  "You design a fictional chat-companion character card.",
  "Input: a Korean fan-wiki profile of an actress. Use it only as loose inspiration for personality, interests and style.",
  "Output plain text (no markdown, no code fences), at most 1300 characters, with exactly these sections:",
  "Personality: 2-3 sentences.",
  "Speaking style: how she texts (tone, habits, verbal tics, emoji use), fitting a young Korean or Japanese woman as suggested by the profile.",
  "Interests: hobbies and passions from the profile; add 2-3 fitting ones if the profile is thin. Never include her real jobs, workplaces or career.",
  "Favourites: 3 anime or manga, 3 films or dramas, 2-3 music artists or songs, 3 foods or drinks, 1-2 games. Real, well-known titles that fit HER personality. Do not default to the same mainstream top picks every time: choose what her character would really love.",
  "Everyday life: 5 small, ordinary, believable details (routines, favourite cafes, weekend habits, little worries).",
  "Conversation hooks: 4 topics she likes to bring up.",
  "Rules: she is a fictional character. No sexual or adult content and no mention of any adult-film career. No other real people's names, no addresses, phone numbers, social media accounts, agency names or family details. Do not claim she is the real person.",
].join("\n");

// A card is injected into every chat prompt, so it must not carry anything we would not say
// ourselves: reject rather than repair.
const FORBIDDEN = [
  /https?:\/\//i,
  /@\w{3,}/,
  /\b\d{2,4}[-\s]?\d{3,4}[-\s]?\d{4}\b/, // phone-like numbers
  /\b(sex|sexual|erotic|nude|porn|AV actress|adult film|adult video)\b/i,
  /성적|섹스|야한|포르노|AV\s?배우|성인\s?영화/,
];

function cleanCard(text) {
  return String(text || "")
    .replace(/^```[a-z]*\s*/i, "")
    .replace(/```\s*$/i, "")
    .replace(/\*\*/g, "")
    .replace(/\n+\s*(Note|Disclaimer|Reminder)\s*:[\s\S]*$/i, "") // trailing meta remark by the model
    .trim();
}

/** @returns {string|null} the cleaned card, or null when it must not be used */
function validateCard(text) {
  const card = cleanCard(text);
  if (card.length < CARD_MIN_CHARS || card.length > CARD_MAX_CHARS) return null;
  for (const section of ["Personality", "Speaking style", "Favourites", "Everyday life"]) {
    if (!card.includes(section)) return null;
  }
  if (FORBIDDEN.some((re) => re.test(card))) return null;
  return card;
}

const sourceHash = (koDescription) =>
  crypto.createHash("sha256").update(koDescription.trim()).digest("hex").slice(0, 16);

/**
 * Generates a card with the model (one retry when the first one is rejected: the output varies
 * from call to call). No storage; used by getCard and by the probe script.
 */
async function generateCard(koDescription, chat = deepseek.chat) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await chat([
      { role: "system", content: GENERATION_PROMPT },
      { role: "user", content: koDescription },
    ]);
    const card = validateCard(result.text);
    if (card) return card;
  }
  return null;
}

const defaultStore = {
  find: (personId) => db.cards().findOne({ person_id: personId }),
  save: (doc) => db.cards().updateOne({ person_id: doc.person_id }, { $set: doc }, { upsert: true }),
};

/**
 * The stored card for this actress, generated (and stored) on first use only. Null when there
 * is none and none could be made (the chat then runs without a card rather than failing).
 */
async function getCard(personId, koDescription, { store = defaultStore, chat = deepseek.chat } = {}) {
  const hash = sourceHash(koDescription);
  try {
    const stored = await store.find(personId);
    if (stored && stored.card) return stored.card; // frozen, whatever her description says now
  } catch (error) {
    console.log("[personaCard] read failed:", personId, error.message);
    return null;
  }

  if ((failedUntil.get(personId) || 0) > Date.now()) return null;
  if (inflight.has(personId)) return inflight.get(personId);

  const job = (async () => {
    try {
      const card = await generateCard(koDescription, chat);
      if (!card) throw new Error("generated card rejected");
      await store.save({ person_id: personId, card, source_hash: hash, created_at: new Date() });
      return card;
    } catch (error) {
      console.log("[personaCard] generation failed:", personId, error.message);
      failedUntil.set(personId, Date.now() + FAIL_TTL_MS);
      return null;
    } finally {
      inflight.delete(personId);
    }
  })();
  inflight.set(personId, job);
  return job;
}

module.exports = { getCard, generateCard, validateCard, sourceHash, defaultStore, GENERATION_PROMPT };
